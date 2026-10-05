// ABOUTME: Offline-проверка совместимости native Codex 0.160 и контрактов agent.
// ABOUTME: Компилирует все fixture schemas и проверяет реальные canned payloads без сервисов.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { validateEvent, validateParams, validateResult, nativeMethodNames, productMethodNames, productNotificationNames, schemaDirectory } from './native-contract.mjs';
import { contentValue, validateArtifactMessage, compileArtifactMessage } from './artifact-contract.mjs';
import openrpc from '../../../services/agent/contracts/codex/openrpc.json' with { type: 'json' };

const cwd = '/tmp/brai-acceptance-native-schema-guard';
const threadId = randomUUID();
const turnId = randomUUID();
const itemId = 'fixture-user-message-1';
const imageClientId = 'brai:agent:v3:fixture-image-operation-1';
const localImageClientId = 'brai:agent:v3:fixture-local-image-operation-1';
const imageInput = [{ type: 'text', text: 'fixture image attachment' }, { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }];
const localImageInput = [{ type: 'localImage', path: `${cwd}/attachment.png` }];
const item = { id: itemId, type: 'userMessage', clientId: imageClientId, content: imageInput };
const localImageItem = { id: 'fixture-local-image-message-1', type: 'userMessage', clientId: localImageClientId, content: localImageInput };
const turn = { id: turnId, items: [item, localImageItem], status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) };
const thread = {
  cliVersion: '0.160.0', createdAt: Math.floor(Date.now() / 1000), cwd, ephemeral: false,
  id: threadId, model: 'fixture-model', modelProvider: 'fixture', name: 'Acceptance fixture',
  preview: 'fixture attachment message', projectId: null, sessionId: randomUUID(), source: 'appServer',
  status: { type: 'active', activeFlags: [] }, turns: [turn], updatedAt: Math.floor(Date.now() / 1000),
};
const sandbox = { type: 'readOnly', networkAccess: false };
const emptyConfig = { config: {}, origins: {} };
const account = { requiresOpenaiAuth: false, account: { type: 'apiKey' }, workspaceRouting: null };
const rateLimits = { rateLimits: { credits: null, individualLimit: null, limitId: null, limitName: null, normalModelSlug: null, planType: null, primary: null, rateLimitReachedType: null, secondary: null, spendControlReached: null } };
const modelList = { data: [{ defaultReasoningEffort: 'medium', description: 'Synthetic fixture model; no inference.', displayName: 'Fixture model', hidden: false, id: 'fixture-model', inputModalities: ['text', 'image'], isDefault: true, model: 'fixture-model', supportedReasoningEfforts: [{ description: 'Fixture setting', reasoningEffort: 'medium' }] }], nextCursor: null };
const commonThreadReply = { approvalPolicy: 'never', approvalsReviewer: 'user', cwd, model: 'fixture-model', modelProvider: 'fixture', sandbox, thread };
const goal = { createdAt: 1, objective: 'fixture goal', status: 'active', threadId, timeUsedSeconds: 0, tokensUsed: 0, updatedAt: 1 };
const params = {
  initialize: { clientInfo: { name: 'brai-acceptance-native-fixture', version: '0.160.0' }, capabilities: {} },
  'account/read': { refreshToken: false },
  'account/rateLimits/read': { excludeResetCreditDetails: true },
  'config/read': { cwd, includeLayers: false },
  'model/list': { limit: 100, includeHidden: false },
  'thread/start': { cwd, model: 'fixture-model', modelProvider: 'fixture' },
  'thread/resume': { threadId, excludeTurns: true },
  'thread/read': { threadId, includeTurns: true },
  'thread/list': {},
  'thread/items/list': { threadId, limit: 100 },
  'thread/turns/list': { threadId },
  'thread/name/set': { threadId, name: 'Acceptance fixture' },
  'thread/unsubscribe': { threadId },
  'thread/archive': { threadId },
  'thread/goal/get': { threadId },
  'thread/goal/set': { threadId, objective: 'fixture goal', status: 'active' },
  'thread/goal/clear': { threadId },
  'thread/settings/update': { threadId },
  'turn/start': { threadId, input: imageInput, clientUserMessageId: imageClientId },
  'turn/steer': { threadId, expectedTurnId: turnId, input: localImageInput, clientUserMessageId: localImageClientId },
  'turn/interrupt': { threadId, turnId },
};
const results = {
  initialize: { codexHome: cwd, platformFamily: 'unix', platformOs: 'linux', userAgent: 'codex-cli 0.160.0 acceptance fixture' },
  'account/read': account,
  'account/rateLimits/read': rateLimits,
  'config/read': emptyConfig,
  'model/list': modelList,
  'thread/start': commonThreadReply,
  'thread/resume': { ...commonThreadReply, thread: { ...thread, turns: [] } },
  'thread/read': { thread },
  'thread/list': { data: [thread], nextCursor: null, backwardsCursor: null },
  'thread/items/list': { data: [{ item, turnId }, { item: localImageItem, turnId }], nextCursor: null, backwardsCursor: null },
  'thread/turns/list': { data: [turn], nextCursor: null, backwardsCursor: null },
  'thread/name/set': {},
  'thread/unsubscribe': { status: 'unsubscribed' },
  'thread/archive': {},
  'thread/goal/get': { goal },
  'thread/goal/set': { goal },
  'thread/goal/clear': { cleared: true },
  'thread/settings/update': {},
  'turn/start': { turn },
  'turn/steer': { turnId },
  'turn/interrupt': {},
};

const sourceCalls = new Set();
for (const path of ['application.ts', 'attachments.ts', 'codex.ts', 'limits.ts', 'title.ts']) {
  const source = await readFile(resolve('services/agent/src', path), 'utf8');
  for (const match of source.matchAll(/codex\.call\(['"]([^'"]+)['"]/g)) sourceCalls.add(match[1]);
  if (path === 'codex.ts') for (const match of source.matchAll(/\bcall\(['"]([^'"]+)['"]/g)) sourceCalls.add(match[1]);
  for (const match of source.matchAll(/call\(['"](thread\/(?:goal\/(?:set|clear)|settings\/update))['"]/g)) sourceCalls.add(match[1]);
}
for (const method of sourceCalls) assert.ok(nativeMethodNames.includes(method), `agent source method missing native fixture schema: ${method}`);
for (const method of sourceCalls) assert.ok(productMethodNames.includes(method), `agent source method missing product contract: ${method}`);
assert.deepEqual(Object.keys(params).sort(), nativeMethodNames.slice().sort(), 'schema map and canned request set differ');
for (const [method, request] of Object.entries(params)) validateParams(method, request);
validateParams('turn/start', { threadId, input: localImageInput, clientUserMessageId: localImageClientId });
validateParams('turn/steer', { threadId, expectedTurnId: turnId, input: imageInput, clientUserMessageId: imageClientId });
for (const [method, result] of Object.entries(results)) validateResult(method, result);

validateEvent('turn/started', { threadId, turn });
validateEvent('turn/completed', { threadId, turn: { ...turn, status: 'completed', completedAt: Math.floor(Date.now() / 1000) } });
validateEvent('item/started', { threadId, turnId, item, startedAtMs: Date.now() });
validateEvent('item/completed', { threadId, turnId, item, completedAtMs: Date.now() });
validateEvent('item/started', { threadId, turnId, item: localImageItem, startedAtMs: Date.now() });
validateEvent('item/completed', { threadId, turnId, item: localImageItem, completedAtMs: Date.now() });
const fixtureSource = await readFile(resolve('deploy/tests/artifacts-acceptance/native-fixture.mjs'), 'utf8');
assert.match(fixtureSource, /for \(const socket of sockets\) if \(socket\.readyState === socket\.OPEN\) socket\.send\(encoded\)/, 'native events must reach every currently connected client');
assert.match(fixtureSource, /function scheduleFinish\(record, turn\)/, 'completion event must not be pinned to the initiating socket');
assert.match(fixtureSource, /event\('turn\/completed', \{ threadId: record\.thread\.id/, 'completion event must be broadcast after reconnect');
assert.match(fixtureSource, /event\('item\/started', \{ threadId: record\.thread\.id/, 'fixture must publish the durable userMessage item');
assert.match(fixtureSource, /event\('item\/completed', \{ threadId: record\.thread\.id/, 'fixture must complete every userMessage item');
assert.match(fixtureSource, /BRAI_NATIVE_FIXTURE_HOLD_MS \?\? 60000/, 'fixture must leave a bounded window for browser steer/reconnect checks');
const attachmentsSource = await readFile(resolve('services/agent/src/attachments.ts'), 'utf8');
const applicationSource = await readFile(resolve('services/agent/src/application.ts'), 'utf8');
assert.match(attachmentsSource, /output\.push\(\{ type: 'image', url: `data:\$\{model\.mimeType\};base64,\$\{data\.toString\('base64'\)\}` \}\)/, 'agent attachments must become native image data URLs');
assert.match(applicationSource, /input: \[\.\.\.\(r\.text\?\.trim\(\) \? \[\{ type: 'text', text: r\.text \}\] : \[\]\), \.\.\.images\]/, 'agent turn input must append image data to the text input');
assert.ok(item.content.some(part => part.type === 'image' && part.url.startsWith('data:image/png;base64,')));
assert.ok(localImageItem.content.some(part => part.type === 'localImage' && part.path.endsWith('/attachment.png')));

const nativeEnvelope = JSON.parse(await readFile(resolve(schemaDirectory, 'ServerNotification.json'), 'utf8'));
new Ajv({ strict: false, validateFormats: false }).compile(nativeEnvelope);
assert.ok(productNotificationNames.includes('turn/started') && productNotificationNames.includes('turn/completed'));
assert.equal(params['account/read'].refreshToken, false, 'startup must not refresh or mutate account credentials');
assert.equal(params['thread/resume'].excludeTurns, true, 'startup must load history via explicit paginated reads');

const toolSource = await readFile(resolve('services/artifacts/src/mcp.ts'), 'utf8');
const toolEntries = [...toolSource.matchAll(/\{ name: '([^']+)', subject: subjects\.[^,]+, request: '([^']+)'/g)].map(match => ({ name: match[1], request: match[2] }));
const exposedTools = toolEntries.map(tool => tool.name).sort();
assert.deepEqual(exposedTools, ['delete','get','link_create','link_revoke','list','prepare','reference_confirm','reference_get','reference_list','reference_reserve','reference_update_state','relation_add','relation_list','relation_remove','stats','update'].sort(), 'MCP source tool surface changed');
for (const tool of toolEntries) compileArtifactMessage(tool.request);
const prepareRequest = { requestId: 'schema-guard-prepare-001', ownerId: 'schema-guard-owner', kind: 'original', metadata: { title: 'small.png', filename: 'small.png', extension: 'png', mimeType: 'image/png', source: 'manual', details: { fixture: true } } };
const artifact = { artifactId: threadId, ownerId: prepareRequest.ownerId, requestId: prepareRequest.requestId, kind: 'original', status: 'pending', title: 'small.png', filename: 'small.png', extension: 'png', mimeType: 'image/png', source: 'manual', sizeBytes: null, sha256: null, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' };
validateArtifactMessage('PrepareRequest', prepareRequest);
validateArtifactMessage('PrepareResponse', { artifact, uploadUrl: 'http://127.0.0.1:13000/upload/fixture_token_0123456789' });
validateArtifactMessage('GetRequest', { artifactId: threadId });
validateArtifactMessage('LinkCreateRequest', { requestId: 'schema-guard-link-001', artifactId: threadId });
assert.deepEqual(contentValue({ structuredContent: { artifact }, content: [{ type: 'text', text: JSON.stringify({ artifact }) }] }), { artifact }, 'official MCP success may omit optional isError=false');
assert.deepEqual(contentValue({ content: [{ type: 'text', text: JSON.stringify({ artifact }) }] }), { artifact }, 'MCP text-only fallback must remain readable');
assert.throws(() => contentValue({ isError: true, structuredContent: { code: 'FAILED' }, content: [] }), /FAILED/);
console.log(JSON.stringify({ result: 'PASS', mode: 'offline-schema-api-guard', nativeVersion: '0.160.0', nativeSchemasCompiled: nativeMethodNames.length * 2 + 1, productMethods: productMethodNames.length, productNotifications: productNotificationNames.length, sourceMethodsCovered: sourceCalls.size, artifactsToolsCovered: exposedTools.length, artifactsRequestSchemasCompiled: new Set(toolEntries.map(tool => tool.request)).size, mcpOptionalIsErrorShape: 'accepted', historyShape: 'image data URL + localImage path + userMessage.clientId + turn/items/list', socketsOpened: false, databasesOpened: false, natsConnections: 0 }));
