// ABOUTME: Проверяет входы управляемого хода и изменения результатов.
// ABOUTME: Не обращается к базе, транспорту или внешним сервисам.
import { appendInput, bytes, canonical, DialoguesFault, fail, id, limits, object, summaryText, text } from './domain.js';
/** Проверяет версию для оптимистической записи. */
export function version(v: unknown) {
    if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v))
        throw new DialoguesFault('INVALID_ARGUMENT', { field: 'expected_version', expected: 'строка с положительным целым числом' });
    return v;
}
/** Проверяет идентификатор и сообщает имя неверного поля. */
export function fieldId(value: unknown, field: string) {
    try {
        return id(value);
    }
    catch {
        throw new DialoguesFault('INVALID_ARGUMENT', { field, expected: 'непустой ID до 256 символов: буквы, цифры и _ . : / -' });
    }
}
function validateSource(value: unknown) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || bytes(value) > limits.metadataBytes))
        fail('INVALID_ARGUMENT');
}
function optionalText(value: unknown) {
    if (value !== undefined && value !== null)
        summaryText(value);
}
/** Проверяет публичный вход или финал, не записывая оригинал. */
export function message(raw: unknown, kind: 'input' | 'final') {
    const m = object(raw, ['id', 'text', 'occurred_at', 'source', 'summary']);
    id(m.id);
    text(m.text, limits.messageBytes, true);
    validateSource(m.source);
    if (m.summary !== undefined)
        summaryText(m.summary);
    // Повторно используем правила дат и источника из общей проверки сообщений.
    const parsed = appendInput({ request_id: 'validate', dialogue: { id: 'validate', channel: 'validate' }, messages: [{ ...m, turn_id: 'validate', role: kind === 'input' ? 'user' : 'assistant', kind }] }).messages[0];
    return { id: parsed.id, text: parsed.text, occurred_at: parsed.occurred_at, source: parsed.source, summary: parsed.summary };
}
/** Проверяет пакет изменений результатов без обращения к хранилищу. */
export function validateChanges(raw: unknown) {
    const a = object(raw ?? {}, ['purpose', 'constraints', 'add', 'update']);
    optionalText(a.purpose);
    optionalText(a.constraints);
    for (const k of ['add', 'update'])
        if (a[k] !== undefined && !Array.isArray(a[k]))
            fail('INVALID_ARGUMENT');
    const seen = new Set<string>();
    for (const [kind, rows] of [['add', a.add ?? []], ['update', a.update ?? []]] as const)
        for (const rawRow of rows) {
            const row = object(rawRow, ['id', 'formulation', 'source_refs', 'status', 'result', 'verification', 'reason', 'remainder']);
            id(row.id);
            if (seen.has(row.id))
                fail('DUPLICATE_RESULT_ID');
            seen.add(row.id);
            if (kind === 'add')
                summaryText(row.formulation);
            else
                optionalText(row.formulation);
            if (row.source_refs !== undefined) {
                if (!Array.isArray(row.source_refs) || new Set(row.source_refs).size !== row.source_refs.length)
                    fail('INVALID_ARGUMENT');
                for (const ref of row.source_refs)
                    id(ref);
            }
            if (row.status !== undefined && !['pending', 'done', 'not_done', 'cancelled'].includes(row.status))
                fail('INVALID_ARGUMENT');
            for (const field of ['result', 'verification', 'reason', 'remainder'])
                optionalText(row[field]);
        }
    return a;
}

const resultFields = ['formulation', 'source_refs', 'status', 'result', 'verification', 'reason', 'remainder'];

/** Применяет частичное изменение результата и проверяет обязательное основание. */
export function mergeResult(previous: Record<string, any>, change: Record<string, any>) {
    const next: Record<string, any> = {};
    for (const field of resultFields)
        next[field] = change[field] === undefined ? previous[field] : change[field];
    if (!next.formulation?.trim() || (['not_done', 'cancelled'].includes(next.status) && !next.reason?.trim()))
        fail('REASON_REQUIRED');
    return { next, changed: resultFields.some(field => canonical(next[field]) !== canonical(previous[field])) };
}

/** Требует объяснение результата, который не выполнен либо отменён. */
export function requireReason(status: string, reason: unknown) {
    if (['not_done', 'cancelled'].includes(status) && (typeof reason !== 'string' || !reason.trim()))
        fail('REASON_REQUIRED');
}
