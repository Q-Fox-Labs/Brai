// ABOUTME: Предоставляет личному Hermes три операции bug-hunt через доверенный broker.
// ABOUTME: Владелец и стабильный профиль взяты из проверенного UID, review недоступен модели.
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const schemas=JSON.parse(readFileSync(new URL('../../bug-hunt/schemas/messages.schema.json',import.meta.url))).definitions;
const ajv=new Ajv({strict:false});addFormats(ajv);
const operations={bug_hunt_report:'report',bug_hunt_get:'get',bug_hunt_list:'list'};
const validate=Object.fromEntries(Object.entries(operations).map(([name,op])=>[name,ajv.compile(schemas[op])]));
const descriptions={
 bug_hunt_report:'Сообщить очищенное наблюдение о сбое. Сохраняй request_id и точное тело для повтора. Квитанция подтверждает только сохранение непроверенного наблюдения, не диагноз и не разрешение исправлять. Не отправляй секреты и полную переписку. При сбое bug-hunt не отправляй сообщение рекурсивно.',
 bug_hunt_get:'Прочитать свою карточку наблюдения с ограниченной страницей ручного разбора.',
 bug_hunt_list:'Прочитать страницу своих наблюдений о сбоях.',
};
/** Формирует каталог только для доверенного профиля; не получает общие credentials пользователя. */
export function createBugHuntCatalog(request,identity){
 if(!identity?.userId||!identity.profileId)throw new Error('FORBIDDEN');
 return {
  list(){return Object.entries(operations).map(([name,op])=>({name,description:descriptions[name],inputSchema:schemas[op]}));},
  async call(name,args,signal){
   if(!Object.hasOwn(operations,name)||!validate[name](args)||Buffer.byteLength(JSON.stringify(args))>65536)throw new Error('INVALID_ARGUMENT');
   try{
    return await request('brai.bug_hunt.v1.'+operations[name],{context:{kind:'hermes',userId:identity.userId,profileId:identity.profileId},input:args},signal,10000);
   }catch(error){
    const code=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'DEPENDENCY_UNAVAILABLE';
    return {isError:true,content:[{type:'text',text:JSON.stringify({code,outcome:name==='bug_hunt_report'?'unknown':'not_accepted',request_id:args.request_id,next_action:'Сохрани исходный request_id и точный вход. Регистрация не подтверждена; не отправляй это наблюдение рекурсивно.'})}]};
   }
  },
 };
}
