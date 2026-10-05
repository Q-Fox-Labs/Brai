// ABOUTME: Загружает и компилирует native Codex и product schemas для acceptance fixture.
// ABOUTME: Остаётся чистым offline модулем без сокетов, БД и NATS.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import Ajv from 'ajv';
import productSchema from '../../../services/agent/contracts/codex/schema.json' with { type: 'json' };
import openrpc from '../../../services/agent/contracts/codex/openrpc.json' with { type: 'json' };

const schemaInput = process.env.BRAI_NATIVE_SCHEMA_DIR;
if (!schemaInput || !isAbsolute(schemaInput)) throw new Error('Set explicit absolute BRAI_NATIVE_SCHEMA_DIR for installed Codex 0.160.0 schema proof');
export const schemaDirectory = resolve(schemaInput);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(productSchema, 'schema.json');

const methodFiles = {
  initialize: ['v1/InitializeParams.json', 'v1/InitializeResponse.json'],
  'account/read': ['v2/GetAccountParams.json', 'v2/GetAccountResponse.json'],
  'account/rateLimits/read': ['v2/NullableGetAccountRateLimitsParams.json', 'v2/GetAccountRateLimitsResponse.json'],
  'config/read': ['v2/ConfigReadParams.json', 'v2/ConfigReadResponse.json'],
  'model/list': ['v2/ModelListParams.json', 'v2/ModelListResponse.json'],
  'thread/start': ['v2/ThreadStartParams.json', 'v2/ThreadStartResponse.json'],
  'thread/resume': ['v2/ThreadResumeParams.json', 'v2/ThreadResumeResponse.json'],
  'thread/read': ['v2/ThreadReadParams.json', 'v2/ThreadReadResponse.json'],
  'thread/list': ['v2/ThreadListParams.json', 'v2/ThreadListResponse.json'],
  'thread/items/list': ['v2/ThreadItemsListParams.json', 'v2/ThreadItemsListResponse.json'],
  'thread/turns/list': ['v2/ThreadTurnsListParams.json', 'v2/ThreadTurnsListResponse.json'],
  'thread/name/set': ['v2/ThreadSetNameParams.json', 'v2/ThreadSetNameResponse.json'],
  'thread/unsubscribe': ['v2/ThreadUnsubscribeParams.json', 'v2/ThreadUnsubscribeResponse.json'],
  'thread/archive': ['v2/ThreadArchiveParams.json', 'v2/ThreadArchiveResponse.json'],
  'thread/goal/get': ['v2/ThreadGoalGetParams.json', 'v2/ThreadGoalGetResponse.json'],
  'thread/goal/set': ['v2/ThreadGoalSetParams.json', 'v2/ThreadGoalSetResponse.json'],
  'thread/goal/clear': ['v2/ThreadGoalClearParams.json', 'v2/ThreadGoalClearResponse.json'],
  'thread/settings/update': ['v2/ThreadSettingsUpdateParams.json', 'v2/ThreadSettingsUpdateResponse.json'],
  'turn/start': ['v2/TurnStartParams.json', 'v2/TurnStartResponse.json'],
  'turn/steer': ['v2/TurnSteerParams.json', 'v2/TurnSteerResponse.json'],
  'turn/interrupt': ['v2/TurnInterruptParams.json', 'v2/TurnInterruptResponse.json'],
};

const schemas = new Map();
for (const [method, [paramsPath, resultPath]] of Object.entries(methodFiles)) {
  const params = JSON.parse(await readFile(resolve(schemaDirectory, paramsPath), 'utf8'));
  const result = JSON.parse(await readFile(resolve(schemaDirectory, resultPath), 'utf8'));
  schemas.set(method, { params: ajv.compile(params), result: ajv.compile(result) });
}

const nativeNotification = JSON.parse(await readFile(resolve(schemaDirectory, 'ServerNotification.json'), 'utf8'));
const validateNativeNotification = ajv.compile(nativeNotification);
const productMethods = new Map(openrpc.methods.map(method => [method.name, {
  params: ajv.compile(method['x-paramsSchema']),
  result: ajv.compile(method.result.schema),
}]));
const productNotifications = new Map(openrpc['x-notifications'].map(notification => [notification.name, ajv.compile(notification.schema)]));

export function validateParams(method, params) {
  const native = schemas.get(method)?.params;
  const product = productMethods.get(method)?.params;
  assert.ok(native, `missing native params schema: ${method}`);
  assert.ok(product, `missing product params schema: ${method}`);
  assert.ok(native(params), `${method} params failed Codex 0.160 schema: ${JSON.stringify(native.errors)}`);
  assert.ok(product(params), `${method} params failed agent contract: ${JSON.stringify(product.errors)}`);
}

export function validateResult(method, result) {
  const native = schemas.get(method)?.result;
  const product = productMethods.get(method)?.result;
  assert.ok(native, `missing native result schema: ${method}`);
  assert.ok(product, `missing product result schema: ${method}`);
  assert.ok(native(result), `${method} result failed Codex 0.160 schema: ${JSON.stringify(native.errors)}`);
  assert.ok(product(result), `${method} result failed agent contract: ${JSON.stringify(product.errors)}`);
}

export function validateEvent(method, params) {
  const packet = { method, params };
  assert.ok(validateNativeNotification(packet), `${method} packet failed Codex 0.160 notification schema: ${JSON.stringify(validateNativeNotification.errors)}`);
  assert.deepEqual(Object.keys(packet).sort(), ['method', 'params'], 'fixture notification must use the native wire shape without jsonrpc');
  const product = productNotifications.get(method);
  assert.ok(product, `missing product notification schema: ${method}`);
  assert.ok(product(params), `${method} params failed agent notification contract: ${JSON.stringify(product.errors)}`);
}

export const nativeMethodNames = [...schemas.keys()];
export const productMethodNames = [...productMethods.keys()];
export const productNotificationNames = [...productNotifications.keys()];
