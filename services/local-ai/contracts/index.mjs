// ABOUTME: Экспортирует owner schemas и проверки DTO сервиса local-ai.
// ABOUTME: Закрытые Draft-07 схемы отклоняют поля вне публичного allowlist.
import Ajv from 'ajv';
import messageSchema from '../schemas/messages.schema.json' with { type: 'json' };
import factsSchema from '../schemas/facts.schema.json' with { type: 'json' };

export const serviceName = 'brai_local_ai';
export const subjects = Object.freeze({
  modelsList: 'brai.local_ai.v1.models.list',
  modelsGet: 'brai.local_ai.v1.models.get',
  catalogSearch: 'brai.local_ai.v1.catalog.search',
  modelsInstall: 'brai.local_ai.v1.models.install',
  operationsGet: 'brai.local_ai.v1.operations.get',
  modelsConfigure: 'brai.local_ai.v1.models.configure',
  modelsLoad: 'brai.local_ai.v1.models.load',
  modelsUnload: 'brai.local_ai.v1.models.unload',
  modelsRemove: 'brai.local_ai.v1.models.remove',
  invokeEmbed: 'brai.local_ai.v1.invoke.embed',
  invokeTranscribe: 'brai.local_ai.v1.invoke.transcribe',
  invokeSynthesize: 'brai.local_ai.v1.invoke.synthesize',
  cancel: 'brai.local_ai.v1.cancel',
  status: 'brai.local_ai.v1.status',
});
export const schemas = Object.freeze({ messages: messageSchema, facts: factsSchema });

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: true, validateFormats: true });
ajv.addFormat('rfc3339-microseconds', value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] && Number.isFinite(Date.parse(value));
});
ajv.addSchema(messageSchema);
ajv.addSchema(factsSchema);
const validators = Object.fromEntries(Object.keys(messageSchema.definitions).map(name => [
  name, ajv.getSchema(messageSchema.$id + '#/definitions/' + name),
]));
const factValidator = ajv.getSchema(factsSchema.$id);
const requestNames = {
  [subjects.modelsList]: 'ModelsListRequest', [subjects.modelsGet]: 'ModelsGetRequest',
  [subjects.catalogSearch]: 'CatalogSearchRequest', [subjects.modelsInstall]: 'InstallRequest',
  [subjects.operationsGet]: 'OperationGetRequest', [subjects.modelsConfigure]: 'ConfigureRequest',
  [subjects.modelsLoad]: 'ModelRevisionRequest', [subjects.modelsUnload]: 'ModelRevisionRequest',
  [subjects.modelsRemove]: 'ModelRevisionRequest', [subjects.invokeEmbed]: 'EmbedRequest',
  [subjects.invokeTranscribe]: 'TranscribeRequest', [subjects.invokeSynthesize]: 'SynthesizeRequest', [subjects.cancel]: 'CancelRequest',
  [subjects.status]: 'StatusRequest',
};
const responseNames = {
  [subjects.modelsList]: 'ModelsListResponse', [subjects.modelsGet]: 'ModelCard',
  [subjects.catalogSearch]: 'CatalogSearchResponse', [subjects.modelsInstall]: 'InstallOperation',
  [subjects.operationsGet]: 'InstallOperation', [subjects.modelsConfigure]: 'ConfiguredResponse',
  [subjects.modelsLoad]: 'ModelMutationResponse', [subjects.modelsUnload]: 'ModelMutationResponse',
  [subjects.modelsRemove]: 'ModelMutationResponse', [subjects.invokeEmbed]: 'EmbedResponse',
  [subjects.invokeTranscribe]: 'TranscribeResponse', [subjects.invokeSynthesize]: 'SynthesizeResponse', [subjects.cancel]: 'CancelResponse',
  [subjects.status]: 'StatusResponse',
};

/** Проверяет DTO запроса для известного NATS subject. */
export function validateRequest(subject, value) {
  const name = requestNames[subject];
  return Boolean(name && validators[name](value));
}

/** Проверяет прямой успешный DTO ответа для известного NATS subject. */
export function validateResponse(subject, value) {
  const name = responseNames[subject];
  return Boolean(name && validators[name](value));
}

/** Проверяет одно именованное определение owner schema. */
export function validateSchema(definitionName, value) {
  return Boolean(validators[definitionName]?.(value));
}

/** Проверяет разрешённые метаданные service_history без поля source из ACL-bound subject. */
export function validateMetadataEvent(value) {
  return Boolean(factValidator(value));
}

/** Проверяет безопасный внутренний error DTO; NATS transport передаёт код заголовком. */
export function validateError(value) {
  return Boolean(validators.ErrorResponse(value));
}
