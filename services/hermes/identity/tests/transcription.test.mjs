// ABOUTME: Проверяет Root Transcription adapter без сети, секретов и настоящего распознавания.
// ABOUTME: Проверяет личный principal, запрет подмены, свежую роль и ограничение ответа.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerTranscription } from '../transcription.mjs';
import { serviceDataScope } from '../../../auth/contracts/service-data-scope.mjs';

const profile = {userId:'user-one', profileId:'11111111-1111-4111-8111-111111111111'};
const endpoint = {url:'http://transcription.test/mcp', token:'fixture-root-token'};
const requestId = '22222222-2222-4222-8222-222222222222';
const settings = {defaultLocalModel:null, allowReplacement:false, policyVersion:2};
const result = {state:'available', result:{requestId, text:'Личный текст', segments:null,
 actualModel:{modelId:'whisper', revision:'v1', profileId:'cpu'}}};

test('seven owner schemas and personal Root delegation; raw public owner injection is rejected', async () => {
 const calls = [];
 const adapter = createOwnerTranscription(profile, endpoint, {fetchImpl:async (url, options) => {
  calls.push({url:String(url), options});
  return Response.json(result);
 }});
 assert.equal(adapter.list().length, 7);
 for (const tool of adapter.list()) {
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.principal, undefined);
 }
 assert.deepEqual(await adapter.call('transcription_result_get', {requestId}), result);
 const sent = calls[0];
 assert.equal(sent.url, 'http://transcription.test/internal/identity/transcription');
 assert.equal(sent.options.redirect, 'error');
 assert.equal(sent.options.headers.Authorization, 'Bearer fixture-root-token');
 assert.deepEqual(JSON.parse(sent.options.body).principal, {scopeType:'user',
  scopeId:serviceDataScope(profile.profileId), ownerId:profile.userId, permissions:['transcription:use']});
 await assert.rejects(adapter.call('transcription_result_get', {requestId, ownerId:'other'}), {code:'INVALID_ARGUMENT'});
 await assert.rejects(adapter.call('transcription_settings_set', {settings, expectedRevision:1}), {code:'FORBIDDEN'});
 assert.equal(calls.length, 1);
});

test('settings write checks current trusted role each call; default denies', async () => {
 let admin = true, checks = 0, calls = 0;
 const adapter = createOwnerTranscription(profile, endpoint, {isAdmin:async () => {checks++; return admin;},
  fetchImpl:async (_url, options) => {
   calls++;
   assert.deepEqual(JSON.parse(options.body).principal.permissions, ['transcription:use','transcription:settings:write']);
   return Response.json({settings, revision:2});
  }});
 await adapter.call('transcription_settings_set', {settings, expectedRevision:1});
 admin = false;
 await assert.rejects(adapter.call('transcription_settings_set', {settings, expectedRevision:2}), {code:'FORBIDDEN'});
 assert.equal(checks, 2);
 assert.equal(calls, 1);
});

test('bounded response and safe error DTO; transport never retries', async () => {
 let calls = 0;
 const failed = createOwnerTranscription(profile, endpoint, {fetchImpl:async () => {
  calls++; return Response.json({errorCode:'NOT_FOUND'}, {status:404});
 }});
 await assert.rejects(failed.call('transcription_result_get', {requestId}), {code:'NOT_FOUND'});
 assert.equal(calls, 1);
 const large = createOwnerTranscription(profile, endpoint, {fetchImpl:async () =>
  new Response('x'.repeat(1_048_577))});
 await assert.rejects(large.call('transcription_result_get', {requestId}), {code:'RESULT_TOO_LARGE'});
 const malformed = createOwnerTranscription(profile, endpoint, {fetchImpl:async () =>
  Response.json({privateException:'secret'}, {status:500})});
 await assert.rejects(malformed.call('transcription_result_get', {requestId}), {code:'INVALID_UPSTREAM_RESPONSE'});
});

test('a lost or invalid submit receipt is unknown and a cancelled unsent request stays cancelled', async () => {
 const args = {clientIdempotencyKey:requestId, audioArtifactId:requestId, requestedModel:null, deadlineAt:null};
 let calls = 0;
 const adapter = createOwnerTranscription(profile, endpoint, {fetchImpl:async () => {
  calls++;
  if (calls === 1) throw new TypeError('connection closed after admission');
  return Response.json({request:{unknown:'malformed receipt'}});
 }});
 const cancelled = AbortSignal.abort();
 await assert.rejects(adapter.call('transcription_request_submit',args,cancelled), {code:'CANCELLED'});
 assert.equal(calls,0);
 await assert.rejects(adapter.call('transcription_request_submit',args), {code:'OUTCOME_UNKNOWN'});
 await assert.rejects(adapter.call('transcription_request_submit',args), {code:'OUTCOME_UNKNOWN'});
 assert.equal(calls,2);
});

test('RELEASE resolves an immutable container every call and sends credentials only through stdin', async () => {
 const release = {url:'http://brai-release-transcription:19342', token:'f'.repeat(64),
  releaseContainer:{imageId:'sha256:'+'2'.repeat(64),packageDigest:'3'.repeat(64)}};
 const container = value => Buffer.from([value,'/brai-release-transcription',release.releaseContainer.imageId,
  true,'healthy','1000:1000',{'com.docker.compose.project':'brai-release-diary','com.docker.compose.service':'transcription'},
  ['/usr/local/bin/node'],['/run/transcription.mjs'],
  [{Destination:'/workspace',Source:'/opt/brai-components/release/transcription/'+release.releaseContainer.packageDigest,
    Type:'bind',RW:false},
   {Destination:'/run/transcription.mjs',Source:'/etc/brai-release/personal-services/transcription/run-v2.mjs',
    Type:'bind',RW:false}],{brai_release_database_private:{},brai_release_nats_private:{}},{},true]
  .map(value=>JSON.stringify(value)).join('\n'));
 const dockerCalls = [];
 let id = 'a'.repeat(64);
 const adapter = createOwnerTranscription(profile, release, {isAdmin:async()=>true,
  fetchImpl:async()=>assert.fail('RELEASE must keep credentials off the host HTTP network'),
  docker:async (argv, options) => {
   dockerCalls.push({argv,options});
   assert.ok(!argv.join(' ').includes(release.token));
   if (argv[0]==='inspect') {
    assert.equal(options.input,undefined);
    return container(id);
   }
   assert.deepEqual(argv.slice(0,5),['exec','-i','--user','1000:1000',id]);
   const [token,body] = options.input.split('\n');
   assert.equal(token,release.token);
   assert.ok(Number(argv.at(-1))>Date.now());
   assert.equal(JSON.parse(body).principal.ownerId,profile.userId);
   return Buffer.from('200\n'+JSON.stringify(result));
  }});
 assert.deepEqual(await adapter.call('transcription_result_get',{requestId}),result);
 id='b'.repeat(64);
 assert.deepEqual(await adapter.call('transcription_result_get',{requestId}),result);
 assert.equal(dockerCalls.length,4);
 assert.ok(!adapter.list().some(tool=>tool.name==='transcription_settings_set'));
 await assert.rejects(adapter.call('transcription_settings_set',{settings,expectedRevision:1}),{code:'FORBIDDEN'});
 assert.equal(dockerCalls.length,4);
});

test('RELEASE rejects an unverified route before any mutating request is sent', async () => {
 const release = {url:'http://brai-release-transcription:19342', token:'f'.repeat(64),
  releaseContainer:{imageId:'sha256:'+'2'.repeat(64),packageDigest:'3'.repeat(64)}};
 let calls = 0;
 const adapter = createOwnerTranscription(profile, release, {
  docker:async argv => {
   calls++;
   assert.equal(argv[0],'inspect');
   return Buffer.from(JSON.stringify({id:'stale-peer'}));
  }});
 await assert.rejects(adapter.call('transcription_request_submit',{
  clientIdempotencyKey:requestId,audioArtifactId:requestId,requestedModel:null,deadlineAt:null,
 }),{code:'UPSTREAM_UNAVAILABLE'});
 assert.equal(calls,1);
});
