// ABOUTME: Даёт валидный ContactResolution только тестовым соседям.
// ABOUTME: Не импортирует runtime Контактов и не является production fallback.
import {randomUUID} from 'node:crypto';
/** Возвращает снимок именно переданного наблюдения. */
export function contactResult(q){const fields=['name','username','photoArtifactId'];return {contactResolutionId:randomUUID(),operationId:q.operationId,packetId:q.packetId,ownerId:q.ownerId,sourceId:q.sourceId,observedAt:q.observedAt,contactId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',identityId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',identity:q.identity,senderSnapshot:{...Object.fromEntries(fields.map(k=>[k,q.profile[k]??null])),observedFields:fields.filter(k=>Object.hasOwn(q.profile,k))},historyEvents:[]};}
