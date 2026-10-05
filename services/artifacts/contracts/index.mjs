// ABOUTME: Экспортирует единственный машинный контракт artifacts и проверку payload.
// ABOUTME: AsyncAPI и потребители используют Draft-07 определения из schemas.
import artifactSchemas from '../schemas/messages.schema.json' with { type: 'json' };
import Ajv from 'ajv';

export const serviceName = 'brai_artifacts';
export const subjects = Object.freeze({
  prepare: 'brai.artifacts.v1.prepare', get: 'brai.artifacts.v1.get', update: 'brai.artifacts.v1.update',
  list: 'brai.artifacts.v1.list', stats: 'brai.artifacts.v1.stats', delete: 'brai.artifacts.v1.delete',
  relationAdd: 'brai.artifacts.v1.relation.add', relationRemove: 'brai.artifacts.v1.relation.remove', relationList: 'brai.artifacts.v1.relation.list',
  referenceReserve: 'brai.artifacts.v1.reference.reserve', referenceGet: 'brai.artifacts.v1.reference.get',
  referenceConfirm: 'brai.artifacts.v1.reference.confirm', referenceList: 'brai.artifacts.v1.reference.list',
  referenceUpdateState: 'brai.artifacts.v1.reference.update-state',
  linkCreate: 'brai.artifacts.v1.link.create', linkRevoke: 'brai.artifacts.v1.link.revoke',
});
export const schemas = artifactSchemas;

const requestNames = {
  [subjects.prepare]: 'PrepareRequest', [subjects.get]: 'GetRequest', [subjects.update]: 'UpdateRequest',
  [subjects.list]: 'ListRequest', [subjects.stats]: 'StatsRequest', [subjects.delete]: 'DeleteRequest',
  [subjects.relationAdd]: 'RelationMutationRequest', [subjects.relationRemove]: 'RelationMutationRequest', [subjects.relationList]: 'RelationListRequest',
  [subjects.referenceReserve]: 'ReferenceReserveRequest', [subjects.referenceGet]: 'ReferenceGetRequest',
  [subjects.referenceConfirm]: 'ReferenceConfirmRequest', [subjects.referenceList]: 'ReferenceListRequest',
  [subjects.referenceUpdateState]: 'ReferenceUpdateStateRequest', [subjects.linkCreate]: 'LinkCreateRequest', [subjects.linkRevoke]: 'LinkRevokeRequest',
};
const responseNames = {
  [subjects.prepare]: 'PrepareResponse', [subjects.get]: 'Artifact', [subjects.update]: 'Artifact', [subjects.list]: 'ListResponse',
  [subjects.stats]: 'StatsResponse', [subjects.delete]: 'Artifact', [subjects.relationAdd]: 'RelationResponse',
  [subjects.relationRemove]: 'RelationResponse', [subjects.relationList]: 'RelationListResponse',
  [subjects.referenceReserve]: 'ReferenceReserveResponse', [subjects.referenceGet]: 'ReferenceResponse',
  [subjects.referenceConfirm]: 'ReferenceResponse', [subjects.referenceList]: 'ReferenceListResponse',
  [subjects.referenceUpdateState]: 'ReferenceResponse', [subjects.linkCreate]: 'LinkCreateResponse', [subjects.linkRevoke]: 'LinkRevokeResponse',
};
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
ajv.addSchema(schemas);
const validators = Object.fromEntries(Object.keys(schemas.definitions).map(name => [name, ajv.getSchema(schemas.$id + '#/definitions/' + name)]));

/** Проверяет успешную нагрузку запроса для известного subject; неизвестный subject возвращает false. */
export function validateRequest(subject, value) {
  const name = requestNames[subject];
  return Boolean(name && validators[name](value));
}

/** Проверяет прямой успешный payload ответа; заголовки NATS-ошибки проверяет транспорт. */
export function validateResponse(subject, value) {
  const name = responseNames[subject];
  return Boolean(name && validators[name](value));
}
