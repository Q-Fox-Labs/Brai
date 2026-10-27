// ABOUTME: Подключает нативный command STT Hermes к owner-bound Transcription через Artifacts.
// ABOUTME: Публикует вход один раз, не повторяет submit и не заменяет выбранную модель.
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateDto } from '../transcription/contracts/index.mjs';
import { loadConfig } from './config.mjs';
import { startBraiTools, fault } from './runtime.mjs';

const MAXIMUM_TIMEOUT_MS = 180_000;
const AUDIO_TYPES = new Set(['audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg']);

async function bounded(promise, signal, mutation = false) {
  let listener;
  const interrupted = new Promise((_resolve, reject) => {
    listener = () => reject(fault(mutation ? 'OUTCOME_UNKNOWN' : 'DEADLINE_EXCEEDED'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', listener); }
}

function sameModel(actual, selected) {
  return actual && ['modelId', 'revision', 'profileId'].every(key => actual[key] === selected[key]);
}

/**
 * Распознаёт обычный аудиофайл через Artifacts/Transcription и создаёт новый UTF-8 output.
 * Владелец берётся только из защищённого runtime; selector — из config.stt.model.
 * Срок publish/submit/poll/output не превышает 180 секунд; потерянный submit не повторяется.
 */
export async function transcribeFile(config, runtime, { input, output, timeoutMs = MAXIMUM_TIMEOUT_MS }) {
  const model = config.stt?.model;
  if (!isAbsolute(input ?? '') || !isAbsolute(output ?? '') || !validateDto('ModelSelector', model)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_TIMEOUT_MS) throw fault('INVALID_ARGUMENT');
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const signal = AbortSignal.timeout(timeoutMs);
  const call = (name, args, mutation = false) => {
    if (signal.aborted) throw fault('DEADLINE_EXCEEDED');
    return bounded(runtime.call(name, args, signal), signal, mutation);
  };
  const source = await bounded(lstat(input), signal);
  if (!source.isFile() || source.size === 0) throw fault('INVALID_ARGUMENT');
  try { await bounded(lstat(output), signal); throw fault('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // AIDEV-NOTE: Вход общего адаптера уже опубликован; сохранённый ID передаётся
  // в Transcription без повторной публикации и изменения состава набора.
  let cachedId;
  if (config.publisher?.configPath) {
    const publisher = JSON.parse(await bounded(readFile(config.publisher.configPath, 'utf8'), signal));
    const candidate = basename(dirname(input));
    if (validateDto('Uuid', candidate) && input === join(publisher.resultRoot, candidate, basename(input))) cachedId = candidate;
  }
  const published = cachedId
    ? await call('fetch_file', { artifactId: cachedId })
    : await call('publish_file', { path: input, requestId: `hermes-stt:${randomUUID()}` }, true);
  if (cachedId && (published.artifactId !== cachedId || published.localPath !== input)) throw fault('INVALID_UPSTREAM_RESPONSE');
  if (!validateDto('Uuid', published?.artifactId) || !AUDIO_TYPES.has(published.mimeType)) throw fault('INVALID_UPSTREAM_RESPONSE');
  const requestedModel = { route: 'local', selection: 'required', modelId: model.modelId };
  const submitted = await call('transcription_request_submit', {
    clientIdempotencyKey: randomUUID(), audioArtifactId: published.artifactId, requestedModel, deadlineAt,
  }, true);
  // AIDEV-NOTE: Невалидный ответ submit мог прийти после admission; новый submit запрещён.
  if (!validateDto('PublicSubmitResult', submitted)) throw fault('OUTCOME_UNKNOWN');
  const requestId = submitted.request.requestId;
  let current = submitted;
  while (true) {
    if (!validateDto('PublicSubmitResult', current) || current.request.requestId !== requestId) throw fault('INVALID_UPSTREAM_RESPONSE');
    const request = current.request;
    if (request.requestedModel?.route !== 'local' || request.requestedModel.selection !== 'required'
      || request.requestedModel.modelId !== model.modelId || request.actualModel && !sameModel(request.actualModel, model)) throw fault('MODEL_MISMATCH');
    if (request.taskState === 'outcome_unknown' || request.resultState === 'delivery_unknown') throw fault('OUTCOME_UNKNOWN');
    if (['failed', 'cancelled'].includes(request.taskState)) throw fault(request.errorCode ?? 'TRANSCRIPTION_FAILED');
    if (['lost', 'expired'].includes(request.resultState)) throw fault('RESULT_UNAVAILABLE');
    if (request.taskState === 'succeeded' && request.resultState === 'available') break;
    try { await delay(250, undefined, { signal }); }
    catch { throw fault('DEADLINE_EXCEEDED'); }
    current = await call('transcription_request_get', { requestId });
  }
  const result = await call('transcription_result_get', { requestId });
  if (!validateDto('ResultGetResult', result)) throw fault('INVALID_UPSTREAM_RESPONSE');
  if (result.state !== 'available') throw fault(result.state === 'delivery_unknown' ? 'OUTCOME_UNKNOWN' : 'RESULT_UNAVAILABLE');
  if (result.result.requestId !== requestId || !sameModel(result.result.actualModel, model)) throw fault('MODEL_MISMATCH');
  const text = result.result.text;
  if (!text.trim()) throw fault('EMPTY_TRANSCRIPT');
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw fault('RESULT_TOO_LARGE');
  if (signal.aborted) throw fault('DEADLINE_EXCEEDED');
  // AIDEV-NOTE: Повторная exclusive-проверка закрывает конфликт output, возникший во время compute.
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(text, 'utf8'); }
  finally { await file.close(); }
  if (signal.aborted) throw fault('DEADLINE_EXCEEDED');
  return { requestId, audioArtifactId: published.artifactId, model: result.result.actualModel, output };
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch {}
if (isMain) {
  let runtime;
  try {
    const args = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index];
      if (!['--input', '--output'].includes(key) || args[key.slice(2)] || !process.argv[index + 1]) throw fault('INVALID_ARGUMENT');
      args[key.slice(2)] = process.argv[index + 1];
    }
    const config = await loadConfig(); runtime = await startBraiTools(config);
    await transcribeFile(config, runtime, args);
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'HERMES_TRANSCRIPTION_FAILED'); process.exitCode = 1;
  } finally { await runtime?.close(); }
}
