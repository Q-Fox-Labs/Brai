// ABOUTME: Преобразует native item в единственное безопасное представление.
// ABOUTME: Передаёт только текст и явные поля; raw reasoning исключены; изображения доступны только в отдельном чтении.
import { bytes, limits, validateCommand } from '../contracts/index.mjs';
import type { DisplayItem, ThreadMetadata } from '../contracts/index.mjs';
/** Сохраняет UTF-8 границу и явный маркер сокращения. */
export function text(value: unknown, cap = 8192): string {
  const source = typeof value === 'string' ? value : '';
  const data = Buffer.from(source);
  if (data.length <= cap) return source;
  let end = cap;
  while ((data[end] & 192) === 128) end--;
  return data.subarray(0, end).toString() + '\n[содержимое сокращено]';
}
/** Удаляет поля профиля, путей, media и контекста из metadata чата. */
export function metadata(thread: any): ThreadMetadata {
  return { id: thread.id, title: text(thread.name ?? thread.preview, 512), preview: text(thread.preview, 512), model: thread.model ?? null, canAcceptDirectInput: thread.canAcceptDirectInput ?? null, updatedAt: thread.updatedAt ?? 0, active: thread.status?.type === 'active', lastMessageAt: (thread.updatedAt ?? 0) * 1000 };
}
/** Представляет native item; media включают только для отдельного чтения, вне history/snapshot. */
export function display(item: any, turnId: string, history = false, media = false): DisplayItem {
  const textual = (parts: any[]) => (parts ?? []).filter(part => (part.type === 'text' || part.type === 'inputText') && typeof part.text === 'string').map(part => part.text).join('\n');
  let content = item.text ?? '';
  if (item.type === 'userMessage') content = textual(item.content);
  if (item.type === 'reasoning') content = (item.summary ?? []).join('\n');
  if (item.type === 'mcpToolCall') content = `${item.server}/${item.tool}\n${textual(item.result?.content)}${item.error?.message ?? ''}`;
  if (item.type === 'dynamicToolCall') content = `${item.tool}\n${textual(item.contentItems)}${item.success === false ? '\nОшибка инструмента' : ''}`;
  if (item.type === 'functionCallOutput') content = typeof item.output === 'string' ? item.output : textual(Array.isArray(item.output) ? item.output : item.output?.content);
  if (item.type === 'collabAgentToolCall') content = `${item.tool}\n${Object.entries(item.agentsStates ?? {}).map(([id, state]: any) => `${id}: ${state.status}`).join('\n')}`;
  const value: DisplayItem = { id: item.id, turnId, type: item.type, text: text(content), truncated: Buffer.byteLength(content) > 8192 };
  if (item.type === 'userMessage') value.imageCount = (item.content ?? []).filter((part: any) => part.type === 'image' || part.type === 'localImage').length;
  if (media && item.type === 'userMessage') {
    const images = (item.content ?? []).filter((part: any) => part.type === 'image').map((part: any) => part.url);
    if (images.length && validateCommand({ action: 'start', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', images }) && images.reduce((sum: number, url: string) => sum + Buffer.byteLength(url.slice(url.indexOf(',') + 1), 'base64'), 0) <= limits.imageBytes) value.images = images;
  }
  if (typeof item.command === 'string') value.command = text(item.command, 16384);
  if (typeof item.aggregatedOutput === 'string') value.output = text(item.aggregatedOutput, 32768);
  if (item.type === 'fileChange') value.diff = text((item.changes ?? []).map((change: any) => `${change.path}\n${change.diff}`).join('\n'), 32768);
  if (typeof item.status === 'string') value.status = item.status;
  if (Object.hasOwn(item, 'exitCode')) value.exitCode = item.exitCode;
  if (Object.hasOwn(item, 'phase')) value.phase = item.phase;
  while (history && bytes(value) > 4096) {
    const key = (['text', 'command', 'output', 'diff'] as ('text' | 'command' | 'output' | 'diff')[]).sort((a, b) => (value[b]?.length ?? 0) - (value[a]?.length ?? 0))[0];
    if (!value[key] || value[key]!.length < 64) throw Object.assign(new Error('ITEM_TOO_LARGE'), { code: 'ITEM_TOO_LARGE', outcome: 'query' });
    value[key] = text(value[key], Math.max(16, Math.floor(Buffer.byteLength(value[key]!) / 2)));
    value.truncated = true;
  }
  return value;
}

/** Скрытые действия передают идентификаторы; reasoning также сообщает наличие публичного текста. */
export function compact(item: DisplayItem): DisplayItem {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const { images, ...message } = item;
    return message;
  }
  return { id: item.id, turnId: item.turnId, type: item.type, text: '', ...(item.type === 'reasoning' ? { hasContent: Boolean(item.text.trim()) } : {}), ...(item.status === undefined ? {} : { status: item.status }), ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }), ...(item.revision === undefined ? {} : { revision: item.revision }) };
}
/** Краткий заголовок без вывода и diff; пустое рассуждение сохраняет пустой заголовок. */
export function summary(item: DisplayItem): DisplayItem {
  const title = item.type === 'reasoning' ? item.text.trim().split('\n')[0] : (item.command ?? item.text.split('\n')[0]) || item.type;
  return { id: item.id, turnId: item.turnId, type: item.type, text: '', status: item.status, exitCode: item.exitCode, revision: item.revision, summary: text(title, 256).replace(/\n\[содержимое сокращено\]$/, '') };
}
