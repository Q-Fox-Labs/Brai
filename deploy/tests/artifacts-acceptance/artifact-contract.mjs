// ABOUTME: Проверяет payloads artifacts и нормализует успешный MCP SDK результат.
// ABOUTME: Не создаёт транспорта или соединений; подходит для offline guard.
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import messages from '../../../services/artifacts/schemas/messages.schema.json' with { type: 'json' };

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(messages, 'artifact-messages');
const validators = new Map();

export function compileArtifactMessage(name) {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `artifact-messages#/definitions/${name}` });
    validators.set(name, validate);
  }
  return validate;
}

export function validateArtifactMessage(name, value) {
  const validate = compileArtifactMessage(name);
  assert.ok(validate(value), `${name} failed artifacts contract schema: ${JSON.stringify(validate.errors)}`);
}

export function contentValue(result) {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'MCP tool result must be an object');
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result.content));
  if (result.structuredContent !== undefined) return result.structuredContent;
  const block = result.content?.find(item => item.type === 'text');
  assert.ok(block, 'MCP tool response must contain structuredContent or JSON text');
  return JSON.parse(block.text);
}
