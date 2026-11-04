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
function changeObject(value: unknown, keys: string[], path: string) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new DialoguesFault('INVALID_ARGUMENT', {field:path, expected:'объект', allowed:keys});
    const row = value as Record<string, any>;
    const unknown = Object.keys(row).find(key => !keys.includes(key));
    if (unknown) throw new DialoguesFault('INVALID_ARGUMENT', {field:path+'.'+unknown.slice(0,128), field_truncated:unknown.length>128, expected:'известное поле', allowed:keys});
    return row;
}
function changeText(value: unknown, path: string, required=false) {
    if (value === undefined && !required) return;
    if (value === null && !required) return;
    try { summaryText(value); } catch { throw new DialoguesFault('INVALID_ARGUMENT', {field:path, expected:'непустая строка'}); }
}
/** Проверяет пакет изменений результатов без обращения к хранилищу. */
export function validateChanges(raw: unknown) {
    const a = changeObject(raw === undefined ? {} : raw, ['purpose','constraints','add','update'], 'changes');
    changeText(a.purpose,'changes.purpose'); changeText(a.constraints,'changes.constraints');
    const seen = new Set<string>();
    for (const kind of ['add','update']) {
        const rows = a[kind] === undefined ? [] : a[kind];
        if (!Array.isArray(rows)) throw new DialoguesFault('INVALID_ARGUMENT', {field:'changes.'+kind,expected:'массив результатов'});
        for (let i=0;i<rows.length;i++) {
            const path=`changes.${kind}[${i}]`;
            const row=changeObject(rows[i], ['id','formulation','source_refs','status','result','verification','reason','remainder'], path);
            fieldId(row.id,path+'.id');
            if (seen.has(row.id)) throw new DialoguesFault('DUPLICATE_RESULT_ID',{field:path+'.id'});
            seen.add(row.id);
            changeText(row.formulation,path+'.formulation',kind==='add');
            if (row.source_refs !== undefined) {
                if (!Array.isArray(row.source_refs) || new Set(row.source_refs).size !== row.source_refs.length)
                    throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.source_refs',expected:'массив уникальных ID входов этого хода'});
                row.source_refs.forEach((ref:unknown,index:number)=>fieldId(ref,`${path}.source_refs[${index}]`));
            }
            const allowed=['pending','done','not_done','cancelled'];
            if (row.status !== undefined && !allowed.includes(row.status))
                throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.status',expected:'одно из допустимых значений',allowed});
            for (const field of ['result','verification','reason','remainder']) changeText(row[field],path+'.'+field);
        }
    }
    return a;
}

const resultFields = ['formulation', 'source_refs', 'status', 'result', 'verification', 'reason', 'remainder'];

/** Применяет частичное изменение результата и проверяет обязательное основание. */
export function mergeResult(previous: Record<string, any>, change: Record<string, any>, path='changes.update') {
    const next: Record<string, any> = {};
    for (const field of resultFields)
        next[field] = change[field] === undefined ? previous[field] : change[field];
    if (!next.formulation?.trim()) throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.formulation',expected:'непустая строка'});
    requireCompletion(next.status,next.result,next.reason,path);
    return { next, changed: resultFields.some(field => canonical(next[field]) !== canonical(previous[field])) };
}

/** Проверяет фактический результат или причину завершения обычного пункта. */
export function requireCompletion(status: string, result: unknown, reason: unknown, path='changes.add') {
    if (status==='done' && (typeof result!=='string' || !result.trim()))
        throw new DialoguesFault('RESULT_REQUIRED',{field:path+'.result',expected:'непустой фактический результат для done'});
    if (['not_done','cancelled'].includes(status) && (typeof reason!=='string' || !reason.trim()))
        throw new DialoguesFault('REASON_REQUIRED',{field:path+'.reason',expected:'непустая причина'});
}
