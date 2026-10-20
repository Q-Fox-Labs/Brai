// ABOUTME: Собирает узкий каталог инструментов из опубликованных owner JSON Schemas.
// ABOUTME: Не копирует DTO соседей и не предоставляет произвольные subjects или SQL.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as alerts from '../alerts/contracts/index.mjs';
import * as localAi from '../local-ai/contracts/index.mjs';

const ajv = new Ajv({ strict: false, validateFormats: true });
addFormats(ajv);
const documents = new Map();
for (const [service, names] of [['timer', ['common', 'commands', 'messages']], ['history', ['common', 'messages']], ['local-ai', ['messages']], ['alerts', ['messages']]]) {
  for (const name of names) {
    const schema = JSON.parse(readFileSync(new URL(`../${service}/schemas/${name}.schema.json`, import.meta.url)));
    ajv.addSchema(schema); documents.set(schema.$id, schema);
  }
}
// Owner local-ai использует свой проверенный формат RFC3339 с микросекундами.
ajv.addFormat('rfc3339-microseconds', value => Number.isFinite(Date.parse(value)));

function resolve(schema, base, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(value => resolve(value, base, seen));
  if (schema.$ref) {
    const url = new URL(schema.$ref, base), key = url.href;
    if (seen.has(key)) throw new Error('CYCLIC_OWNER_SCHEMA');
    const document = documents.get(url.origin + url.pathname);
    const target = url.hash.slice(2).split('/').reduce((node, part) => node?.[part], document);
    if (!target) throw new Error('MISSING_OWNER_SCHEMA');
    return resolve(target, url.origin + url.pathname, new Set([...seen, key]));
  }
  return Object.fromEntries(Object.entries(schema).filter(([name]) => !['$id', '$schema', 'examples'].includes(name)).map(([name, value]) => [name, resolve(value, base, seen)]));
}
function definition(service, file, name) {
  const base = [...documents.keys()].find(id => id.includes(`/${service}/`) && id.endsWith(`/${file}.schema.json`));
  return { base, schema: documents.get(base).definitions[name] };
}
function withoutOwner(schema, ownerKey) {
  const value = structuredClone(schema);
  if (value.properties) delete value.properties[ownerKey];
  if (value.required) value.required = value.required.filter(key => key !== ownerKey);
  for (const key of ['oneOf', 'allOf', 'anyOf']) if (value[key]) value[key] = value[key].map(entry => withoutOwner(entry, ownerKey));
  return value;
}

export const natsTools = [];
function add(name, subject, service, file, request, response, ownerKey, mutation = false, command = false) {
  const { schema, base } = definition(service, file, request);
  const inputSchema = { type: 'object', ...withoutOwner(resolve(schema, base), ownerKey) };
  const validateInput = ajv.compile(inputSchema);
  const compiledRequest = ajv.compile(resolve(schema, base));
  const output = response ? definition(service, 'messages', response) : undefined;
  const compiledResponse = output ? ajv.compile(resolve(output.schema, output.base)) : () => true;
  const alertOperation = name.replace('alerts_', '');
  const validateRequest = service === 'local-ai' ? value => localAi.validateRequest(subject, value) : service === 'alerts' ? value => alerts.validateRequest(alertOperation, value) : compiledRequest;
  const validateResponse = service === 'local-ai' ? value => localAi.validateResponse(subject, value) : service === 'alerts' ? value => alerts.validateResponse(alertOperation, value) : compiledResponse;
  natsTools.push({ name, subject, ownerKey, mutation, command, inputSchema, validateInput, validateRequest, validateResponse,
    description: command ? 'Отправить намерение Timer v2. PubAck означает хранение, итог читать timer_command_get с прежним commandId.' : mutation ? 'Операция владельца. При потере ответа исход неизвестен; автоматического повтора нет.' : 'Чтение опубликованного API в области текущего владельца.' });
}
for (const [operation, request, response] of [['snapshot', 'SnapshotRequest', 'SnapshotResponse'], ['history', 'HistoryRequest', 'HistoryResponse'], ['command', 'CommandLookupRequest', 'CommandLookupResponse'], ['statistics', 'StatisticsRequest', 'StatisticsResponse']])
  add(`timer_${operation}_get`, `brai.timer.v2.query.${operation}`, 'timer', 'messages', request, response, 'userId');
for (const operation of ['start', 'stop', 'edit', 'delete'])
  add(`timer_${operation}`, `brai.timer.v2.command.${operation}`, 'timer', 'commands', `${operation[0].toUpperCase()}${operation.slice(1)}Command`, undefined, 'userId', true, true);
for (const operation of ['list', 'get']) add(`history_${operation}`, `brai.history.v1.query.${operation}`, 'history', 'messages', `${operation}Request`, `${operation}Response`, 'user_id');
for (const operation of ['list', 'get', 'summary', 'read', 'read_all']) {
  const key = operation === 'read_all' ? 'readAll' : operation;
  add(`alerts_${operation}`, alerts.subjects[operation], 'alerts', 'messages', `${key}Request`, `${key}Response`, 'user_id', operation.startsWith('read'));
}
for (const [operation, request, response] of [
  ['modelsList', 'ModelsListRequest', 'ModelsListResponse'], ['modelsGet', 'ModelsGetRequest', 'ModelCard'],
  ['catalogSearch', 'CatalogSearchRequest', 'CatalogSearchResponse'], ['modelsInstall', 'InstallRequest', 'InstallOperation'],
  ['operationsGet', 'OperationGetRequest', 'InstallOperation'], ['modelsConfigure', 'ConfigureRequest', 'ConfiguredResponse'],
  ['modelsLoad', 'ModelRevisionRequest', 'ModelMutationResponse'], ['modelsUnload', 'ModelRevisionRequest', 'ModelMutationResponse'],
  ['modelsRemove', 'ModelRevisionRequest', 'ModelMutationResponse'], ['invokeEmbed', 'EmbedRequest', 'EmbedResponse'],
  ['invokeSynthesize', 'SynthesizeRequest', 'SynthesizeResponse'],
  ['cancel', 'CancelRequest', 'CancelResponse'], ['status', 'StatusRequest', 'StatusResponse']]) {
  const words = operation.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  add(`local_ai_${words}`, localAi.subjects[operation], 'local-ai', 'messages', request, response, 'ownerId', !['modelsList', 'modelsGet', 'catalogSearch', 'operationsGet', 'status'].includes(operation));
}

export const elementsNames = new Set(['elements_structure_create', 'elements_element_create', 'elements_element_revise', 'elements_move_create', 'elements_move_link', 'elements_element_activate', 'elements_graph_get', 'elements_timeline_get', 'elements_moves_available', 'elements_move_claim', 'elements_move_complete', 'elements_move_fail', 'elements_planning_packet', 'elements_planning_bind', 'elements_planning_build', 'elements_planning_apply']);
export const historyNames = new Set(['history_categories_list', 'history_types_list', 'history_type_get']);
export const transcriptionNames = new Set(['transcription_request_submit', 'transcription_request_get', 'transcription_request_cancel', 'transcription_models_list', 'transcription_settings_get', 'transcription_settings_set', 'transcription_result_get']);

/** Проверяет опубликованную схему MCP без изменения аргументов. */
export function compileInput(schema) { return ajv.compile(schema); }
