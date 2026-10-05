// ABOUTME: Загружает owner DTO transcription и предоставляет проверку границ.
// ABOUTME: JSON Schema остаётся единственным источником wire-форматов.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import historyCommon from '../../history/schemas/common.schema.json' with { type: 'json' };
import historyMessages from '../../history/schemas/messages.schema.json' with { type: 'json' };
import methods from './methods.json' with { type: 'json' };
import transcriptionSchemas from '../schemas/messages.schema.json' with { type: 'json' };

export const schemas = transcriptionSchemas;
export const methodMap = Object.freeze(methods);

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats(ajv);
ajv.addSchema(historyCommon);
ajv.addSchema(historyMessages);
ajv.addSchema(transcriptionSchemas);
const validators = new Map(Object.keys(transcriptionSchemas.definitions).map((name) => {
  const validate = ajv.getSchema(`${transcriptionSchemas.$id}#/definitions/${name}`);
  if (!validate) throw new Error(`Missing JSON Schema validator: ${name}`);
  return [name, validate];
}));

/** Проверяет DTO по owner-схеме; неизвестное имя или невалидное значение возвращает false. */
export function validateDto(name, value) {
  return Boolean(validators.get(name)?.(value));
}

/** Возвращает DTO при соответствии схеме; иначе выбрасывает TypeError без вывода payload. */
export function assertDto(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new TypeError(`Unknown transcription DTO: ${name}`);
  if (!validate(value)) {
    const error = new TypeError(`Invalid transcription DTO: ${name}`);
    throw error;
  }
  return value;
}
