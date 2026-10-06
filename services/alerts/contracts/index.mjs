// ABOUTME: Публикует единственные схемы и валидаторы границы alerts v1.
// ABOUTME: Не содержит бизнес-логики и не импортирует внутренний код сервиса.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const schema = JSON.parse(readFileSync(new URL('../schemas/messages.schema.json', import.meta.url), 'utf8'));
export const limits = Object.freeze({ maxRequestBytes: 65_536, maxEventBytes: 65_536, maxResponseBytes: 524_288, defaultPageSize: 50, maxPageSize: 100, active: 8, queue: 64, deadlineMs: 10_000 });
export const subjects = Object.freeze({ ingest: 'brai.alerts.v1.ingest', changed: 'brai.alerts.v1.changed', list: 'brai.alerts.v1.query.list', get: 'brai.alerts.v1.query.get', summary: 'brai.alerts.v1.query.summary', read: 'brai.alerts.v1.command.read', read_all: 'brai.alerts.v1.command.read_all' });
export const errorStatus = Object.freeze({ INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, REQUEST_TOO_LARGE: 413, RESULT_TOO_LARGE: 413, NOT_FOUND: 404, EVENT_ID_CONFLICT: 409, UNKNOWN_TYPE: 400, BUSY: 503, DATABASE_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, INTERNAL: 500 });
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema(schema);
const validators = Object.fromEntries(Object.keys(schema.definitions).map(name => [name, ajv.compile({ $ref: schema.$id + '#/definitions/' + name })]));
const names = { list: 'list', get: 'get', summary: 'summary', read: 'read', read_all: 'readAll' };
/** Проверяет точную форму запроса, не меняя его значения. */
export const validateRequest = (operation, value) => !!validators[names[operation] + 'Request']?.(value);
/** Проверяет ответ операции по публичной схеме владельца. */
export const validateResponse = (operation, value) => !!validators[names[operation] + 'Response']?.(value);
/** Проверяет сообщение долговечного входа до его бизнес-обработки. */
export const validateIngest = value => !!validators.ingest(value);
/** Проверяет сигнал изменения без содержимого уведомления. */
export const validateChanged = value => !!validators.changed(value);
/** Проверяет безопасное тело сервисной ошибки. */
export const validateError = value => !!validators.error(value);
