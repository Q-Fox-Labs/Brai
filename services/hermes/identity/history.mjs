// ABOUTME: Предоставляет Hermes чтение общего системного каталога History через NATS.
// ABOUTME: Не принимает область владельца и не предоставляет изменение справочника или событий.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fault } from '../runtime.mjs';

const schema = JSON.parse(readFileSync(new URL('../../history/schemas/tools.schema.json', import.meta.url)));
const common = JSON.parse(readFileSync(new URL('../../history/schemas/common.schema.json', import.meta.url)));
const messages = JSON.parse(readFileSync(new URL('../../history/schemas/messages.schema.json', import.meta.url)));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema(common);
ajv.addSchema(messages);
ajv.addSchema(schema);
const operations = {
 history_categories_list: ['categoriesListRequest', 'categories-list'],
 history_types_list: ['typesListRequest', 'types-list'],
 history_type_get: ['typeGetRequest', 'type-get'],
};
const validators = Object.fromEntries(Object.entries(operations).map(([name, [definition]]) =>
 [name, ajv.getSchema(schema.$id + '#/definitions/' + definition)]));

/** Возвращает только публичные чтения каталога с проверкой owner-схемы до отправки. */
export function createHistoryCatalog(request) {
 return {
  list() {
   return Object.entries(operations).map(([name, [definition]]) => {
    const inputSchema = structuredClone(schema.definitions[definition]);
    for (const [key, value] of Object.entries(inputSchema.properties)) {
     if (value.$ref === 'common.schema.json#/definitions/id') inputSchema.properties[key] = structuredClone(common.definitions.id);
    }
    return { name, description: name.replaceAll('_', ' '), inputSchema };
   });
  },
  async call(name, args, signal) {
   if (!Object.hasOwn(operations, name) || !validators[name]?.(args)) throw fault('INVALID_ARGUMENT');
   return request('brai.history.v1.query.' + operations[name][1], args, signal);
  },
 };
}
