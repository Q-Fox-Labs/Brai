// ABOUTME: Задаёт закрытые команды и пределы публичной границы agent v2.
// ABOUTME: Не импортирует исполнитель или Node; native payload проверяет владелец.
export const subjects = { rpc: 'brai.agent.v2.rpc', event: 'brai.agent.v2.event' };
export const limits = { frame: 1048576, input: 65536, state: 524288, clients: 128, queue: 64, threads: 16, pending: 64, operations: 4096, request: 32768 };
export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const string = { type: 'string', minLength: 1, maxLength: 128 };
const properties = { permissionMode: { type: 'string', minLength: 1, maxLength: 128, enum: ['ask', 'auto', 'full'] }, model: string, effort: string, action: string, projectId: string, threadId: string, generation: string, operationId: string, turnId: string, expectedTurnId: string, requestId: string, itemId: string, itemIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: string }, text: { type: 'string', minLength: 1, maxLength: 65536 }, answer: {}, cursor: { type: 'string', minLength: 1, maxLength: 2048 } };
const read = ['projectId', 'threadId'];
const write = [...read, 'generation', 'operationId'];
const fields = { projects: [], status: [], models: [], threads: ['projectId', '?cursor'], create: ['projectId', 'generation', 'operationId', '?model', '?permissionMode'], open: read, turns: [...read, '?cursor'], items: [...read, '?turnId', '?cursor'], activities: [...read, 'turnId', 'itemIds'], item: [...read, 'turnId', 'itemId'], start: [...write, 'text', '?model', '?effort', '?permissionMode'], steer: [...write, 'expectedTurnId', 'text'], interrupt: [...write, 'turnId'], answer: [...write, 'requestId', 'answer'] };
export const commandSchema = { $schema: 'http://json-schema.org/draft-07/schema#', oneOf: Object.entries(fields).map(([action, names]) => ({ type: 'object', additionalProperties: false, required: ['action', ...names.filter(name => !name.startsWith('?'))], properties: Object.fromEntries([['action', { const: action }], ...names.map(name => [name.replace('?', ''), properties[name.replace('?', '')]])]) })) };
/** Проверяет закрытую команду до передачи через транспорт. */
export function validateCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(fields, value.action)) return false;
  const names = fields[value.action];
  if (Object.keys(value).some(key => key !== 'action' && !names.some(name => name.replace('?', '') === key))) return false;
  for (const name of names) {
    const key = name.replace('?', ''), field = value[key], rule = properties[key];
    if (field === undefined && name.startsWith('?')) continue;
    if (rule.type === 'array' && (!Array.isArray(field) || field.length < 1 || field.length > 100 || new Set(field).size !== field.length || field.some(id => typeof id !== 'string' || id.length < 1 || id.length > 128))) return false;
    if (rule.enum && !rule.enum.includes(field)) return false;
    if (field === undefined || (rule.type === 'string' && (typeof field !== 'string' || field.length < rule.minLength || field.length > rule.maxLength))) return false;
  }
  return bytes(value) <= limits.input;
}
/** Проверяет внешнюю оболочку; EventSchema проверяется на AG-UI границе отдельно. */
export function validateEnvelope(value) {
  const snapshot = value?.event?.snapshot;
  if (!Array.isArray(snapshot?.items) || snapshot.items.length > 128 || !Array.isArray(snapshot.requests) || snapshot.requests.length > limits.pending || typeof snapshot.state !== 'string' || snapshot.thread?.id !== value.threadId) return false;
  return value?.event?.type === 'STATE_SNAPSHOT' && snapshot && typeof value.projectId === 'string' && typeof value.threadId === 'string' && typeof value.generation === 'string' && typeof value.epoch === 'string' && Number.isSafeInteger(value.seq) && value.seq >= 0 && snapshot.projectId === value.projectId && snapshot.threadId === value.threadId && snapshot.generation === value.generation && snapshot.epoch === value.epoch && snapshot.seq === value.seq && bytes(value) <= limits.frame;
}
