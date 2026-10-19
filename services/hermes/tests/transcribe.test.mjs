// ABOUTME: Проверяет файловый STT-мост Hermes без моделей, сети и пользовательских файлов.
// ABOUTME: Подтверждает один submit, фиксированную модель, срок и сохранность output при отказе.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeFile } from '../transcribe.mjs';

const artifactId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const model = { modelId: 'gigaam-v3-e2e-ctc', revision: 'cec030b4c4f35d928e4a9044a3bdb29ebd499fac', profileId: 'gigaam_pytorch' };
const config = { ownerId: 'fixed-owner', stt: { model } };
const selected = { route: 'local', selection: 'required', modelId: model.modelId };
const view = (overrides = {}) => ({ request: { requestId, requestedModel: selected, actualModel: model,
  taskState: 'succeeded', resultState: 'available', revision: 1, errorCode: null,
  createdAt: '2026-10-19T20:00:00.000Z', updatedAt: '2026-10-19T20:00:00.000Z', ...overrides } });
const result = (overrides = {}) => ({ state: 'available', result: { requestId, text: 'Привет, Brai!', segments: null, actualModel: model, ...overrides } });

async function fixture(run) {
  const directory = await mkdtemp(fileURLToPath(new URL('../../../tmp/hermes-stt-', import.meta.url)));
  const input = join(directory, 'voice.ogg'), output = join(directory, 'transcript.txt');
  await writeFile(input, 'OggS-fixture');
  const calls = [];
  const responses = { publish_file: () => ({ artifactId, mimeType: 'audio/ogg' }),
    transcription_request_submit: () => view(), transcription_request_get: () => view(), transcription_result_get: () => result() };
  const runtime = { async call(name, args, signal) {
    calls.push({ name, args, signal });
    return responses[name](args, signal);
  } };
  try { await run({ directory, input, output, calls, responses, runtime }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('STT publishes once, submits a required local model, polls metadata and writes exact private UTF-8', async () => {
  await fixture(async ({ input, output, runtime, calls, responses }) => {
    responses.transcription_request_submit = () => view({ taskState: 'running', resultState: 'not_ready', actualModel: null });
    const before = Date.now();
    assert.deepEqual(await transcribeFile(config, runtime, { input, output }), { requestId, audioArtifactId: artifactId, model, output });
    assert.deepEqual(calls.map(call => call.name), ['publish_file', 'transcription_request_submit', 'transcription_request_get', 'transcription_result_get']);
    const submit = calls[1].args;
    assert.deepEqual(submit.requestedModel, selected);
    assert.equal(submit.audioArtifactId, artifactId);
    assert.match(submit.clientIdempotencyKey, /^[0-9a-f-]{36}$/);
    assert.ok(Date.parse(submit.deadlineAt) >= before + 180_000 && Date.parse(submit.deadlineAt) <= Date.now() + 180_000);
    assert.ok(calls.every(call => !Object.hasOwn(call.args, 'ownerId') && call.signal === calls[0].signal), 'owner remains fixed by the existing runtime, never supplied as a model argument');
    assert.deepEqual(calls[2].args, { requestId }); assert.deepEqual(calls[3].args, { requestId });
    assert.equal(await readFile(output, 'utf8'), 'Привет, Brai!');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  });
});

test('output conflict and invalid owner-selector fields stop before publication', async () => {
  await fixture(async ({ input, output, runtime, calls }) => {
    await writeFile(output, 'keep');
    await assert.rejects(transcribeFile(config, runtime, { input, output }), /OUTPUT_EXISTS/);
    await assert.rejects(transcribeFile({ ...config, stt: { model: { ...model, ownerId: 'other-owner' } } }, runtime, { input, output }), /INVALID_ARGUMENT/);
    assert.equal(calls.length, 0); assert.equal(await readFile(output, 'utf8'), 'keep');
  });
});

test('lost submit acknowledgement and reported unknown outcome never submit again', async () => {
  for (const response of [() => { throw Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN' }); }, () => view({ taskState: 'outcome_unknown', resultState: 'delivery_unknown' }), () => ({ malformed: true })]) {
    await fixture(async ({ input, output, runtime, calls, responses }) => {
      responses.transcription_request_submit = response;
      await assert.rejects(transcribeFile(config, runtime, { input, output }), /OUTCOME_UNKNOWN/);
      assert.equal(calls.filter(call => call.name === 'transcription_request_submit').length, 1);
      assert.equal(calls.length, 2); await assert.rejects(stat(output), { code: 'ENOENT' });
    });
  }
});

test('one deadline bounds pending submit and metadata polling without another compute', async () => {
  for (const pendingSubmit of [true, false]) {
    await fixture(async ({ input, output, runtime, calls, responses }) => {
      responses.transcription_request_submit = pendingSubmit ? () => new Promise(() => {}) : () => view({ taskState: 'running', resultState: 'not_ready' });
      await assert.rejects(transcribeFile(config, runtime, { input, output, timeoutMs: 30 }), pendingSubmit ? /OUTCOME_UNKNOWN/ : /DEADLINE_EXCEEDED/);
      assert.equal(calls.filter(call => call.name === 'transcription_request_submit').length, 1);
      assert.equal(calls[0].signal.aborted, true); await assert.rejects(stat(output), { code: 'ENOENT' });
    });
  }
});

test('foreign model, mismatched request and unavailable results never write a transcript', async () => {
  const foreign = { ...model, revision: 'different-revision' };
  for (const [submit, final, code] of [
    [view({ actualModel: foreign }), result(), 'MODEL_MISMATCH'],
    [view(), result({ actualModel: foreign }), 'MODEL_MISMATCH'],
    [view(), result({ requestId: artifactId }), 'MODEL_MISMATCH'],
    [view({ resultState: 'lost' }), result(), 'RESULT_UNAVAILABLE'],
    [view(), { state: 'expired', errorCode: 'RESULT_UNAVAILABLE' }, 'RESULT_UNAVAILABLE'],
    [view(), result({ text: '   ' }), 'EMPTY_TRANSCRIPT'],
  ]) {
    await fixture(async ({ input, output, runtime, calls, responses }) => {
      responses.transcription_request_submit = () => submit;
      responses.transcription_result_get = () => final;
      await assert.rejects(transcribeFile(config, runtime, { input, output }), error => error.code === code);
      assert.equal(calls.filter(call => call.name === 'transcription_request_submit').length, 1);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    });
  }
});

test('an output created during transcription is preserved without overwrite or resubmit', async () => {
  await fixture(async ({ input, output, runtime, calls, responses }) => {
    responses.transcription_result_get = async () => { await writeFile(output, 'keep'); return result(); };
    await assert.rejects(transcribeFile(config, runtime, { input, output }), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), 'keep');
    assert.equal(calls.filter(call => call.name === 'transcription_request_submit').length, 1);
  });
});

test('native command entry executes through a stable symlink and reports only a safe config error', async () => {
  await fixture(async ({ directory }) => {
    const entry = fileURLToPath(new URL('../transcribe.mjs', import.meta.url)), link = join(directory, 'transcribe.mjs');
    await symlink(entry, link);
    for (const path of [entry, link]) {
      const child = spawnSync(process.execPath, [path, '--input', '/missing/input', '--output', '/missing/output'], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
      assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr.trim(), 'INVALID_HERMES_CONFIG');
    }
  });
});
