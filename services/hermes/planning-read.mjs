// ABOUTME: Читает только именованные файлы owner planning_packet с точными UTF-8 хешами.
// ABOUTME: Не открывает пути, не исполняет код и не заменяет независимую проверку.
import { createHash } from 'node:crypto';

export const planningReadTool = {
  name: 'game_core_planning_packet_read',
  description: 'Read the manifest or an exact named file from the current claimed planning packet without code execution or local files. Omit file_name for the complete file_sha256 map to record in baseline.inputs. Read every named packet/rule/input file in chunks until next_offset is null. inputs_sha256 is an aggregate, not the per-file hashes. This does not bind or approve a plan.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['attempt_id'], properties: {
    attempt_id: { type: 'string', format: 'uuid' }, file_name: { type: 'string', minLength: 1, maxLength: 500 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 12000 },
  } },
};

/** The owner API establishes attempt/revision authority; pagination never selects a filesystem path. */
export function readPlanningPacket(packet, args, fault) {
  const files = packet?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      !Object.keys(files).length || Object.values(files).some(value => typeof value !== 'string') ||
      Buffer.byteLength(JSON.stringify(files)) > 524288) throw fault('INVALID_UPSTREAM_RESPONSE');
  const file_sha256 = Object.fromEntries(Object.entries(files).map(([key, value]) =>
    [key, createHash('sha256').update(value, 'utf8').digest('hex')]));
  const result = { baseline_id: packet.baseline_id, source_revision: packet.source_revision,
    element_kind: packet.element_kind, inputs_sha256: packet.inputs_sha256, file_sha256 };
  if (!Object.hasOwn(args, 'file_name')) {
    if (Object.hasOwn(args, 'offset') || Object.hasOwn(args, 'limit')) throw fault('INVALID_ARGUMENT');
    return result;
  }
  if (!Object.hasOwn(files, args.file_name)) throw fault('NOT_FOUND');
  const characters = Array.from(files[args.file_name]), offset = args.offset ?? 0, limit = args.limit ?? 12000;
  if (offset > characters.length) throw fault('INVALID_ARGUMENT');
  const end = Math.min(offset + limit, characters.length);
  return { ...result, file_name: args.file_name, offset, total_characters: characters.length,
    content: characters.slice(offset, end).join(''), next_offset: end < characters.length ? end : null };
}
