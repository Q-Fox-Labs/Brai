// ABOUTME: Проверяет публичные формы artifacts и wire-ограничения.
// ABOUTME: Тесты не подключают NATS, HTTP, хранилище или базу данных.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import { serviceName, subjects, schemas, validateRequest, validateResponse } from '../contracts/index.mjs';

const id = '0f4a9092-c6f6-4a18-9f11-e332701ef4a2';
const timestamp = '2026-10-05T12:00:00Z';
const artifact = {
  artifactId: id, ownerId: 'owner-1', requestId: 'upload-1', kind: 'original', status: 'ready',
  title: 'Photo', filename: 'photo.webp', extension: 'webp', mimeType: 'image/webp', source: 'agent',
  sizeBytes: 3, sha256: 'a'.repeat(64), internalUrl: 'http://artifacts/files/' + id,
  createdAt: timestamp, updatedAt: timestamp,
};
const scope = { ownerId: 'owner-1', projectId: 'project-1', threadId: 'thread-1', operationId: 'operation-1' };

test('Draft-07 definitions compile and AsyncAPI names every service subject', async () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  ajv.addSchema(schemas);
  assert.equal(schemas.$schema, 'http://json-schema.org/draft-07/schema#');
  for (const name of Object.keys(schemas.definitions)) assert.ok(ajv.getSchema(schemas.$id + '#/definitions/' + name), name);
  const uploadHeaders = ajv.getSchema(schemas.$id + '#/definitions/UploadResponseHeaders');
  const validHeaders = { 'X-Artifact-Id': '0f4a9092-c6f6-4a18-9f11-e332701ef4a2', 'X-Artifact-State': 'ready', 'X-Artifact-Size': '0', 'X-Artifact-SHA256': 'a'.repeat(64), Location: 'http://artifacts/files/key', 'Content-Length': '0' };
  assert.equal(uploadHeaders(validHeaders), true);
  assert.equal(uploadHeaders({ ...validHeaders, 'X-Artifact-State': 'pending' }), false);
  const missingSize = { ...validHeaders };
  delete missingSize['X-Artifact-Size'];
  assert.equal(uploadHeaders(missingSize), false);
  const asyncapi = await readFile(new URL('../asyncapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(asyncapi);
  assert.equal(document.asyncapi, '3.1.0');
  assert.equal(document['x-http-upload'].successStatus, 201);
  assert.equal(document['x-http-upload'].responseHeaders.$ref, './schemas/messages.schema.json#/definitions/UploadResponseHeaders');
  assert.equal(document.channels.replies.address, null);
  assert.equal(document.channels.replies['x-nats-reply-subject'], 'message.reply');
  for (const operation of Object.values(document.operations)) assert.equal('address' in operation.reply, false);
  assert.equal(Object.keys(document.channels.replies.messages).length, new Set(Object.keys(document.channels.replies.messages)).size);
  for (const subject of Object.values(subjects)) assert.ok(asyncapi.includes(subject), subject);
  assert.equal(serviceName, 'brai_artifacts');
});

test('prepare accepts stable opaque IDs and rejects absent owner or unlisted metadata', () => {
  const request = { requestId: 'event:conversation:message:17', ownerId: 'owner-1', kind: 'original', metadata: { title: 'Photo', filename: 'photo.webp', extension: 'webp', mimeType: 'image/webp', source: 'agent' } };
  assert.equal(validateRequest(subjects.prepare, request), true);
  assert.equal(validateRequest(subjects.prepare, { ...request, ownerId: undefined }), false);
  assert.equal(validateRequest(subjects.prepare, { ...request, metadata: { ...request.metadata, path: '../../photo.webp' } }), false);
  assert.equal(validateRequest('brai.artifacts.v1.unknown', request), false);
});

test('Artifact readiness controls digest and internal URL; deleted rows retain size and digest', () => {
  assert.equal(validateResponse(subjects.get, artifact), true);
  assert.equal(validateResponse(subjects.get, { ...artifact, status: 'pending' }), false);
  assert.equal(validateResponse(subjects.get, { ...artifact, sha256: null }), false);
  const pending = { ...artifact, status: 'pending', sizeBytes: null, sha256: null };
  delete pending.internalUrl;
  assert.equal(validateResponse(subjects.get, pending), true);
  const deleted = { ...artifact, status: 'deleted', deletedAt: timestamp };
  delete deleted.internalUrl;
  assert.equal(validateResponse(subjects.get, deleted), true);
  assert.equal(validateResponse(subjects.get, { ...deleted, sha256: null }), false);
});

test('reference reserve preserves owner scope and confirmation needs exact native binding pair', () => {
  const reserve = { scope, clientUserMessageId: 'brai:operation-1', commandHash: 'b'.repeat(64), attachments: [{ originalArtifactId: id, modelArtifactId: id }] };
  assert.equal(validateRequest(subjects.referenceReserve, reserve), true);
  assert.equal(validateRequest(subjects.referenceReserve, { ...reserve, scope: { ...scope, ownerId: undefined } }), false);
  assert.equal(validateRequest(subjects.referenceUpdateState, { scope, state: 'pending' }), false);
  const ref = { ...reserve, state: 'confirmed', turnId: 'turn-1', itemId: 'item-1', createdAt: timestamp, updatedAt: timestamp };
  assert.equal(validateResponse(subjects.referenceConfirm, { reference: ref }), true);
  assert.equal(validateResponse(subjects.referenceConfirm, { reference: { ...ref, itemId: undefined } }), false);
});

test('history references use owner/project/thread scope without requiring unknown operationId', () => {
  const queryScope = { ownerId: 'owner-1', projectId: 'project-1', threadId: 'thread-1' };
  assert.equal(validateRequest(subjects.referenceList, { scope: queryScope, nativeItemIds: ['item-1', 'item-2'] }), true);
  assert.equal(validateRequest(subjects.referenceList, { scope: scope, nativeItemIds: ['item-1'] }), false);
});

test('list uses stable sort keys; writes and direct successful payloads match subject schemas', () => {
  const list = { filter: { ownerId: 'owner-1', status: 'ready' }, sort: 'sizeBytes', order: 'desc', limit: 20, offset: 0 };
  assert.equal(validateRequest(subjects.list, list), true);
  assert.equal(validateRequest(subjects.list, { ...list, sort: 'filename' }), false);
  assert.equal(validateRequest(subjects.delete, { requestId: 'delete-1', artifactId: id }), true);
  assert.equal(validateRequest(subjects.relationAdd, { requestId: 'rel-1', modelArtifactId: id, originalArtifactId: id }), true);
  assert.equal(validateRequest(subjects.linkCreate, { requestId: 'link-1', artifactId: id }), true);
  assert.equal(validateResponse(subjects.prepare, { artifact, uploadUrl: 'http://artifacts/upload/opaque' }), true);
  assert.equal(validateResponse(subjects.prepare, { result: { artifact, uploadUrl: 'http://artifacts/upload/opaque' } }), false);
});
