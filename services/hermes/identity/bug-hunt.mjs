// ABOUTME: Предоставляет личному Hermes справку и операции bug-hunt через доверенный broker.
// ABOUTME: Владелец и стабильный профиль взяты из проверенного UID, review недоступен модели.
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const schemas=JSON.parse(readFileSync(new URL('../../bug-hunt/schemas/messages.schema.json',import.meta.url))).definitions;
const systemDocument=JSON.parse(readFileSync(new URL('../../bug-hunt/schemas/v2.schema.json',import.meta.url)));
const agentGuide=JSON.parse(readFileSync(new URL('../../bug-hunt/contracts/agent-guide.json',import.meta.url)));
const ajv=new Ajv({strict:false});addFormats(ajv);
ajv.addSchema(systemDocument);
const operations={bug_hunt_report:'report',bug_hunt_get:'get',bug_hunt_list:'list'};
const systemOperations={bug_hunt_search:'search',bug_hunt_similar:'similar',bug_hunt_enrichment:'enrichment',bug_hunt_groups_list:'groups-list',bug_hunt_groups_get:'groups-get'};
const allOperations={...operations,...systemOperations};
const helpInput=ajv.compile(agentGuide.inputSchema);
const inputSchema=(name,op)=>Object.hasOwn(systemOperations,name)?systemDocument.definitions[op]:schemas[op];
const validate=Object.fromEntries(Object.entries(allOperations).map(([name,op])=>[name,Object.hasOwn(systemOperations,name)?ajv.getSchema(systemDocument.$id+'#/definitions/'+op):ajv.compile(schemas[op])]));
const descriptions={
 bug_hunt_report:'Зарегистрировать наблюдение о сбое; сначала прочитай bug_hunt_help.',
 bug_hunt_get:'Прочитать свою карточку наблюдения с ограниченной страницей ручного разбора.',
 bug_hunt_list:'Прочитать страницу своих наблюдений о сбоях.',
 bug_hunt_search:'Найти свои наблюдения по тексту и коду; прочитать покрытие индекса.',
 bug_hunt_similar:'Прочитать похожие наблюдения по сохранённым Gemma embeddings, без подтверждения бага.',
 bug_hunt_enrichment:'Прочитать группы, предварительные метки и состояние обработки карточки.',
 bug_hunt_groups_list:'Прочитать страницу своих групп одинаковых проявлений.',
 bug_hunt_groups_get:'Прочитать ограниченную страницу участников своей группы.',
};
/** Формирует каталог только для доверенного профиля; не получает общие credentials пользователя. */
export function createBugHuntCatalog(request,identity){
 if(!identity?.userId||!identity.profileId)throw new Error('FORBIDDEN');
 return {
  list(){return [{name:'bug_hunt_help',description:'Как зарегистрировать наблюдение: правила и пример.',inputSchema:agentGuide.inputSchema,annotations:{readOnlyHint:true,idempotentHint:true}},...Object.entries(allOperations).map(([name,op])=>({name,description:descriptions[name],inputSchema:inputSchema(name,op),...(Object.hasOwn(systemOperations,name)?{annotations:{readOnlyHint:true,idempotentHint:true}}:{})}))];},
  async call(name,args,signal){
   if(name==='bug_hunt_help'){if(!helpInput(args))throw new Error('INVALID_ARGUMENT');return {instructions:agentGuide.help};}
   if(!Object.hasOwn(allOperations,name)||!validate[name](args)||Buffer.byteLength(JSON.stringify(args))>65536)throw new Error('INVALID_ARGUMENT');
   try{
    return await request((Object.hasOwn(systemOperations,name)?'brai.bug_hunt.v2.':'brai.bug_hunt.v1.')+allOperations[name],{context:{kind:'hermes',userId:identity.userId,profileId:identity.profileId},input:args},signal,10000);
   }catch(error){
    const code=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'DEPENDENCY_UNAVAILABLE';
    return {isError:true,content:[{type:'text',text:JSON.stringify({code,outcome:name==='bug_hunt_report'?'unknown':'not_accepted',request_id:args.request_id,next_action:'Сохрани исходный request_id и точный вход. Регистрация не подтверждена; не отправляй это наблюдение рекурсивно.'})}]};
   }
  },
 };
}
