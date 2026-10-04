// ABOUTME: Задаёт закрытые команды и пределы публичной границы agent v2.
// ABOUTME: Не импортирует исполнитель или Node; native payload проверяет владелец.
export const subjects = { rpc: 'brai.agent.v2.rpc', event: 'brai.agent.v2.event' };
export const limits = { frame: 1048576, input: 983040, images: 8, imageBytes: 655360, state: 524288, clients: 128, queue: 64, threads: 16, pending: 64, operations: 4096, request: 32768 };
export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const string = { type: 'string', minLength: 1, maxLength: 128 };
// AIDEV-NOTE: Последние символы проверяют нулевые pad bits; конец исключает даже завершающий перевод строки.
const imagePattern = '^data:image/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)(?![\\s\\S])';
const properties = { permissionMode: { type: 'string', minLength: 1, maxLength: 128, enum: ['ask', 'auto', 'full'] }, model: string, effort: string, action: string, projectId: string, threadId: string, generation: string, operationId: string, turnId: string, expectedTurnId: string, requestId: string, itemId: string, itemIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: string }, text: { type: 'string', minLength: 0, maxLength: 65536 }, images: { type: 'array', minItems: 1, maxItems: limits.images, items: { type: 'string', pattern: imagePattern } }, answer: {}, cursor: { type: 'string', minLength: 1, maxLength: 2048 } };
const read = ['projectId', 'threadId'];
const write = [...read, 'generation', 'operationId'];
const fields = { projects: [], status: [], models: [], threads: ['projectId', '?cursor'], create: ['projectId', 'generation', 'operationId', '?model', '?permissionMode'], open: read, turns: [...read, '?cursor'], items: [...read, '?turnId', '?cursor'], activities: [...read, 'turnId', 'itemIds'], item: [...read, 'turnId', 'itemId'], start: [...write, '?text', '?images', '?model', '?effort', '?permissionMode'], steer: [...write, 'expectedTurnId', '?text', '?images'], archive: write, interrupt: [...write, 'turnId'], answer: [...write, 'requestId', 'answer'] };
export const commandSchema = { $schema: 'http://json-schema.org/draft-07/schema#', oneOf: Object.entries(fields).map(([action, names]) => ({ type: 'object', additionalProperties: false, required: ['action', ...names.filter(name => !name.startsWith('?'))], ...(['start', 'steer'].includes(action) ? { anyOf: [{ required: ['text'], properties: { text: { pattern: '\\S' } } }, { required: ['images'] }] } : {}), properties: Object.fromEntries([['action', { const: action }], ...names.map(name => [name.replace('?', ''), properties[name.replace('?', '')]])]) })) };
/** Проверяет структуру и JSON bytes; decoded budget и MIME signature проверяет сервер. */
export function validateCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(fields, value.action)) return false;
  const names = fields[value.action];
  if (Object.keys(value).some(key => key !== 'action' && !names.some(name => name.replace('?', '') === key))) return false;
  for (const name of names) {
    const key = name.replace('?', ''), field = value[key], rule = properties[key];
    if (field === undefined && name.startsWith('?')) continue;
    if (rule.type === 'array') {
      if (!Array.isArray(field) || field.length < rule.minItems || field.length > rule.maxItems) return false;
      if (key === 'images') { if (field.some(image => typeof image !== 'string' || !new RegExp(imagePattern).test(image))) return false; }
      else if (new Set(field).size !== field.length || field.some(id => typeof id !== 'string' || Array.from(id).length < 1 || Array.from(id).length > 128)) return false;
    }
    if (rule.enum && !rule.enum.includes(field)) return false;
    if (field === undefined || (rule.type === 'string' && (typeof field !== 'string' || Array.from(field).length < rule.minLength || Array.from(field).length > rule.maxLength))) return false;
  }
  if (['start', 'steer'].includes(value.action) && !value.text?.trim() && !value.images?.length) return false;
  return bytes(value) <= limits.input;
}
/** Проверяет закрытую проекцию лимита для Status и клиентов границы agent. */
export function validateLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['state', 'revision', 'observedAt', 'windows'].includes(key))) return false;
  if (!['loading', 'ready', 'stale', 'unavailable'].includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!(value.observedAt === null || Number.isSafeInteger(value.observedAt) && value.observedAt >= 0) || !Array.isArray(value.windows) || value.windows.length > 2) return false;
  const slots = new Set();
  return value.windows.every(window => {
    if (!window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).some(key => !['slot', 'remainingPercent', 'windowDurationMins', 'resetsAt'].includes(key))) return false;
    if (!['primary', 'secondary'].includes(window.slot) || slots.has(window.slot)) return false;
    slots.add(window.slot);
    return Number.isInteger(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100
      && (window.windowDurationMins === null || Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins >= 0)
      && (window.resetsAt === null || Number.isSafeInteger(window.resetsAt) && window.resetsAt >= 0);
  });
}
/** Проверяет внешнюю оболочку; EventSchema проверяется на AG-UI границе отдельно. */
export function validateEnvelope(value) {
  const snapshot = value?.event?.snapshot;
  if (!Array.isArray(snapshot?.items) || snapshot.items.length > 128 || !Array.isArray(snapshot.requests) || snapshot.requests.length > limits.pending || typeof snapshot.state !== 'string' || snapshot.thread?.id !== value.threadId) return false;
  return value?.event?.type === 'STATE_SNAPSHOT' && snapshot && typeof value.projectId === 'string' && typeof value.threadId === 'string' && typeof value.generation === 'string' && typeof value.epoch === 'string' && Number.isSafeInteger(value.seq) && value.seq >= 0 && snapshot.projectId === value.projectId && snapshot.threadId === value.threadId && snapshot.generation === value.generation && snapshot.epoch === value.epoch && snapshot.seq === value.seq && bytes(value) <= limits.frame;
}
