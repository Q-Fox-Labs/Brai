// ABOUTME: Создаёт синтетический валидный Resolution только для тестовых соседей.
// ABOUTME: Не является runtime fallback и не импортирует внутренний код Каналов.
import {randomUUID} from 'node:crypto';
import {inputHash} from '../dist/contracts.js';
export const connectionId='33333333-3333-4333-8333-333333333333',channelId='44444444-4444-4444-8444-444444444444';
/** Сохраняет адрес/версию родителя для синтетического ответа. */
export function channelResult(q,parent=null){
 const stamp=q.asOf,rules=[];
 return {resolutionId:randomUUID(),packetId:q.packetId,ownerId:q.ownerId,sourceId:q.sourceId,asOf:stamp,policyAsOf:parent?.policyAsOf??stamp,type:{code:'telegram',version:1},connectionId:parent?.connectionId??connectionId,connectionVersion:parent?.connectionVersion??1,channelId:parent?.channelId??channelId,channelVersion:parent?.channelVersion??1,rulesVersion:parent?.rulesVersion??inputHash(rules),locationRef:parent?.locationRef??'project',destination:parent?.destination??{transport:'telegram',connectionId,...q.sourceRef},processing:{mode:'temporal',scenario:q.direction==='incoming'?'incoming.v1':'outgoing.v1'},assignments:{},fieldOrigins:{},appliedRules:[],basedOnResolutionId:parent?.resolutionId??null,snapshot:{connection:{name:'fixture',type:{code:'telegram',version:1}},channel:{name:'fixture',extensions:{}},rules}};
}
