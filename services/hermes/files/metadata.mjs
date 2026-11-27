// ABOUTME: Даёт Hermes чтение метаданных Artifacts в области фиксированного владельца.
// ABOUTME: Использует схемы владельца; не открывает модели произвольные owner или NATS subjects.
import { subjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';

const itemSchema = { type: 'object', additionalProperties: false, required: ['artifactId'], properties: {
  artifactId: { type: 'string', format: 'uuid' }, caption: { type: 'string', maxLength: 65536 },
  presentation: { enum: ['photo', 'video', 'audio', 'document', 'voice', 'animation'] },
} };
export const fileMetadataTools = [
  { name: 'files_prepare', description: 'Подготовить упорядоченный набор Artifacts для выдачи: files или album. Вставь возвращённый deliveryMarker отдельной строкой в ответ; подписи и порядок сохранятся во всех каналах.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['mode', 'items'], properties: {
      mode: { enum: ['files', 'album'] }, items: { type: 'array', minItems: 1, maxItems: 100, items: itemSchema },
    },
  } },
  { name: 'files_get', description: 'Метаданные пользовательского артефакта текущего владельца.', inputSchema: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: { type: 'string', format: 'uuid' } } } },
  { name: 'files_list', description: 'Список готовых пользовательских файлов текущего владельца; байты получать fetch_file.', inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 } } } },
];

/** Проверяет владельца каждого DTO до возврата модели; ошибки не раскрывают чужие метаданные. */
export async function fileMetadata(name, args, ownerId, request, fail, signal) {
  if (name === 'files_prepare') {
    const files = [];
    for (const item of args.items) {
      const file = await fileMetadata('files_get', { artifactId: item.artifactId }, ownerId, request, fail, signal);
      if (file.status !== 'ready') throw fail('NOT_READY');
      files.push(file);
    }
    return { fileSet: args, files, deliveryMarker: 'BRAI_FILES:' + JSON.stringify(args) };
  }
  const operation = name === 'files_get' ? 'get' : 'list';
  const payload = operation === 'get' ? args : { filter: { ownerId, status: 'ready' }, sort: 'createdAt', order: 'desc', limit: args.limit ?? 100, offset: args.offset ?? 0 };
  if (!validateRequest(subjects[operation], payload)) throw fail('INVALID_ARGUMENT');
  const value = await request(subjects[operation], payload, signal);
  if (!validateResponse(subjects[operation], value)) throw fail('INVALID_UPSTREAM_RESPONSE');
  const items = operation === 'get' ? [value] : value.items;
  if (items.some(item => item.ownerId !== ownerId)) throw fail('FORBIDDEN');
  if (operation === 'get' && value.artifactId.toLowerCase() !== args.artifactId.toLowerCase()) throw fail('INVALID_UPSTREAM_RESPONSE');
  // Внутренние HTTP адреса и owner остаются у адаптера, а не у модели.
  const visible = ({ ownerId, internalUrl, ...item }) => item;
  return operation === 'get' ? visible(value) : { ...value, items: items.map(visible) };
}
