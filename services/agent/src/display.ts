// ABOUTME: Преобразует native item в единственное безопасное представление.
// ABOUTME: Передаёт только текст и явные поля; raw reasoning исключены; изображения доступны только в отдельном чтении.
import { createHash } from 'node:crypto';
import { bytes, limits, validateCommand } from '../contracts/index.mjs';
import type { DisplayItem, ThreadMetadata, AgentGoal, PlanProgress } from '../contracts/index.mjs';
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
  const cap = item.type === 'plan' ? 32768 : 8192;
  const value: DisplayItem = { id: item.id, turnId, type: item.type, text: text(content, cap), truncated: Buffer.byteLength(content) > cap };
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
  while (item.type === 'plan' ? bytes(value) > 49152 : history && bytes(value) > 4096) {
    const key = (['text', 'command', 'output', 'diff'] as ('text' | 'command' | 'output' | 'diff')[]).sort((a, b) => (value[b]?.length ?? 0) - (value[a]?.length ?? 0))[0];
    if (!value[key] || value[key]!.length < 64) throw Object.assign(new Error('ITEM_TOO_LARGE'), { code: 'ITEM_TOO_LARGE', outcome: 'query' });
    value[key] = text(value[key], Math.max(16, Math.floor(Buffer.byteLength(value[key]!) / 2)));
    value.truncated = true;
  }
  return value;
}

/** Читает текст сообщения частями без сокращения; курсор связывает смещение с неизменным содержимым. */
export function messagePage(item: any, turnId: string, cursor?: string): { item: DisplayItem; nextCursor: string | null } {
  const source: string = item.type === 'userMessage'
    ? (item.content ?? []).filter((part: any) => (part.type === 'text' || part.type === 'inputText') && typeof part.text === 'string').map((part: any) => part.text).join('\n')
    : item.text ?? '';
  const hash = createHash('sha256').update(source).digest('hex');
  const match = cursor?.match(/^([a-f0-9]{64}):([1-9][0-9]*)$/);
  const start = match ? Number(match[2]) : 0;
  if (cursor && (!match || match[1] !== hash || !Number.isSafeInteger(start) || start >= source.length || /[\uDC00-\uDFFF]/.test(source[start]))) {
    throw Object.assign(new Error('STALE_ITEM'), { code: 'STALE_ITEM', outcome: 'query' });
  }
  // AIDEV-NOTE: 8192 UTF-16 единиц помещаются даже при JSON escaping; surrogate pair не разрываем.
  let end = Math.min(source.length, start + 8192);
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end])) end--;
  const value = display({ ...item, ...(item.type === 'userMessage' ? { content: [] } : { text: '' }) }, turnId);
  value.text = source.slice(start, end);
  value.truncated = end < source.length;
  if (item.type === 'userMessage') value.imageCount = (item.content ?? []).filter((part: any) => part.type === 'image' || part.type === 'localImage').length;
  return { item: value, nextCursor: value.truncated ? `${hash}:${end}` : null };
}

/** Скрытые действия передают идентификаторы; reasoning также сообщает наличие публичного текста. */
export function compact(item: DisplayItem): DisplayItem {
  if (item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'plan') {
    const { images, ...message } = item;
    return message;
  }
  return { id: item.id, turnId: item.turnId, type: item.type, text: '', ...(item.type === 'reasoning' ? { hasContent: Boolean(item.text.trim()) } : {}), ...(item.status === undefined ? {} : { status: item.status }), ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }), ...(item.revision === undefined ? {} : { revision: item.revision }) };
}

/** Ограничивает цель для снимка; native состояние и счётчики сохраняет без переименования. */
export function goal(value: any): AgentGoal | null {
  if (!value) return null;
  return { threadId: value.threadId, objective: text(value.objective, 16384), status: value.status, timeUsedSeconds: value.timeUsedSeconds, tokensUsed: value.tokensUsed, tokenBudget: value.tokenBudget ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(Buffer.byteLength(value.objective) > 16384 ? { truncated: true } : {}) };
}

/** Шаги принадлежат только живому turn/plan/updated; история не восстанавливает этот список. */
export function progress(value: any): PlanProgress {
  return { state: 'live', turnId: value.turnId, explanation: value.explanation == null ? null : text(value.explanation, 4096), steps: value.plan.slice(0, 100).map((entry: any) => ({ step: text(entry.step, 512), status: entry.status })), truncated: value.plan.length > 100 || value.plan.some((entry: any) => Buffer.byteLength(entry.step) > 512) || Buffer.byteLength(value.explanation ?? '') > 4096 };
}
/** Краткий заголовок без вывода и diff; пустое рассуждение сохраняет пустой заголовок. */
export function summary(item: DisplayItem): DisplayItem {
  const title = item.type === 'reasoning' ? item.text.trim().split('\n')[0] : (item.command ?? item.text.split('\n')[0]) || item.type;
  return { id: item.id, turnId: item.turnId, type: item.type, text: '', status: item.status, exitCode: item.exitCode, revision: item.revision, summary: text(title, 256).replace(/\n\[содержимое сокращено\]$/, '') };
}

/** Последнее сообщение определяет итог; вопрос ищется в видимом тексте, вне кода и адресов ссылок. */
export function messageAttention(item: DisplayItem): { finalMessageId: string | null; awaitingReply: boolean } {
  const final = item.type === 'agentMessage' && item.phase === 'final_answer';
  // AIDEV-NOTE: Query-параметры URL не являются вопросом; текст подписи ссылки остаётся видимым.
  const prose = item.text.replace(/```[\s\S]*?```|`[^`]*`/g, '')
    .replace(/\]\((?:\\.|[^\\)])*\)/g, ']')
    .replace(/^\s{0,3}\[[^\]]+\]:[^\n]*$/gm, '')
    .replace(/(?:https?:\/\/|mailto:)[^\s<>]+/gi, '');
  return { finalMessageId: final ? item.id : null, awaitingReply: final && /[?？]/u.test(prose) };
}
