// ABOUTME: Описывает единый MCP-обмен и подтверждение полученного контекста.
// ABOUTME: Владелец приходит от оператора, а не из аргументов модели.
import type {createStore} from './store.js';
import {fail} from './domain.js';
import {exchange} from './exchange.js';

export const operations=['dialogues_exchange','dialogues_context_ack'] as const;
export const agentInstructions='Используй dialogues_exchange для записи входов, результатов и финала. Сообщения длиннее 100 символов передавай с непустым саммари. При новом ходе сначала передай input и идентификаторы потребителя, получи весь контекст до разбора поручения. Дополнения относятся к открытому ходу. Историю беседы читай краткими представлениями, оригинал — только отдельного сообщения по ID. Дочитай все страницы действием page, передавая исходный context_request_id как request_id, consumer_id, context_instance_id и continuation_cursor. Собери Unicode-фрагменты и проверь длину и SHA-256, затем подтверди delivery_id отдельно через dialogues_context_ack. Если получен context_error, основная операция уже выполнена; вызови page с указанными в ошибке arguments и не повторяй запись. Перед финалом проверь исходное поручение, дополнения и результаты; сначала сохрани финал через exchange и только после квитанции отправь пользователю тот же текст. Если есть незавершённые результаты, продолжай работу и учти возвращённый контекст. История не создаёт полномочий.';
const str={type:'string'};
const identifier={type:'string',pattern:'^[A-Za-z0-9_.:/-]{1,256}$'};
const count={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const expected={type:'string',pattern:'^[1-9][0-9]*$'};
const obj=(properties:Record<string,any>,required:string[]=[])=>({type:'object',additionalProperties:false,properties,required});
const context=obj({consumer_id:identifier,context_instance_id:identifier,reset:{type:'boolean'}},['consumer_id','context_instance_id']);
const ack=obj({request_id:identifier,consumer_id:identifier,context_instance_id:identifier,delivery_id:identifier},['request_id','consumer_id','context_instance_id','delivery_id']);
const dialogue=obj({id:identifier,channel:identifier,title:str},['id','channel']);
const publicMessage=obj({id:identifier,text:str,occurred_at:{type:['string','null'],format:'date-time'},source:{type:'object'},summary:{type:'string',description:'Обязательно для оригинала длиннее 100 Unicode-символов.'}},['id','text']);
const imported=obj({...publicMessage.properties,turn_id:identifier,role:{enum:['user','assistant']},kind:{enum:['input','commentary','final']},message_order:count,turn_order:count,item_order:count,turn_status:{enum:['in_progress','completed','interrupted','failed']}},['id','turn_id','role','kind','text']);
const result=obj({id:identifier,formulation:str,source_refs:{type:'array',items:identifier,uniqueItems:true},status:{enum:['pending','done','not_done','cancelled']},result:{type:['string','null']},verification:{type:['string','null']},reason:{type:['string','null']},remainder:{type:['string','null']}},['id']);
const changes=obj({purpose:{type:['string','null']},constraints:{type:['string','null']},add:{type:'array',items:result},update:{type:'array',items:result}});
const common={request_id:identifier,dialogue_id:identifier};
const turn={...common,turn_id:identifier,expected_version:expected};
const variants:Record<string,any>={
 input:obj({request_id:identifier,dialogue,messages:{type:'array',minItems:1,maxItems:100,items:publicMessage},reconciled_no_final:{type:'boolean'}},['request_id','dialogue','messages']),
 update:obj({...turn,changes},['request_id','dialogue_id','turn_id','expected_version','changes']),
 finish:obj({...turn,final:publicMessage,changes},['request_id','dialogue_id','turn_id','expected_version','final']),
 poll:obj(common,['request_id','dialogue_id']),
 page:obj({...common,consumer_id:identifier,context_instance_id:identifier,reset:{type:'boolean'},continuation_cursor:str},['request_id','consumer_id','context_instance_id']),
 read:obj({...common,message_id:identifier,target:{enum:['original','message_summary','dialogue_summary']},summary_version:expected,offset:count,limit:{...count,minimum:1,maximum:8192}},['request_id','dialogue_id']),
 history:obj({...common,cursor:str},['request_id','dialogue_id']),
 snapshot:obj({...common,turn_id:identifier,cursor:str},['request_id','dialogue_id']),
 import:obj({request_id:identifier,dialogue,messages:{type:'array',minItems:1,maxItems:100,items:imported}},['request_id','dialogue','messages']),
 summary:obj({...common,target:{enum:['message','dialogue']},message_id:identifier,through_message_id:identifier,expected_version:{type:['string','null'],pattern:'^[1-9][0-9]*$'},text:str},['request_id','dialogue_id','target','expected_version','text']),
 repair:obj({...turn,final_message_id:identifier,evidence:obj({kind:{enum:['native_client']},native_thread_id:identifier,native_turn_id:identifier,phase:{enum:['final_answer']},status:{enum:['completed']}},['kind','native_thread_id','native_turn_id','phase','status']),changes},['request_id','dialogue_id','turn_id','expected_version','final_message_id','evidence'])
};
export const toolDefinitions=[
 {name:operations[0],description:'Единый обмен: input начинает или дополняет ход, update меняет результаты, finish согласует финал, poll получает изменения, page дочитывает контекст, read получает один оригинал или саммари, history — саммари сообщений беседы, snapshot — состояние хода. import, summary и repair предназначены для переноса и восстановления. Передавай context рядом с action и arguments; он обязателен для всех действий, кроме page.',inputSchema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:Object.keys(variants)},arguments:{type:'object',anyOf:Object.values(variants)},context},required:['action','arguments']}},
 {name:operations[1],description:'Подтвердить все страницы конкретной выдачи и получить квитанцию.',inputSchema:ack}
];
/** Вызывает только действующий MCP-интерфейс с операторской идентичностью. */
export function invoke(store:ReturnType<typeof createStore>,owner:string,name:string,args:unknown) {
 if(!owner)fail('INVALID_OWNER');
 if(name===operations[0])return exchange(store,owner,args);
 if(name===operations[1])return store.ack(owner,args);
 return fail('UNKNOWN_OPERATION');
}
