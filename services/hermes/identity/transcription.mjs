// ABOUTME: Вызывает Transcription через Root delegation для проверенного личного профиля.
// ABOUTME: Bearer остаётся в Root; worker передаёт только публичные owner DTO.
import { methodMap, schemas, validateDto } from '../../transcription/contracts/index.mjs';
import { serviceDataScope } from '../../auth/contracts/service-data-scope.mjs';
import { fault } from '../runtime.mjs';

const maxRequestBytes = 65_536, maxResponseBytes = 1_048_576;
const writeMethods = new Set(['request.submit', 'request.cancel', 'settings.set']);
const uncertainErrors = new Set(['DEADLINE_EXCEEDED', 'CANCELLED', 'INVALID_UPSTREAM_RESPONSE', 'RESULT_TOO_LARGE',
 'UPSTREAM_UNAVAILABLE', 'REQUEST_OUTCOME_UNKNOWN', 'INTERNAL']);
function expand(value) {
 if (!value || typeof value !== 'object') return value;
 if (Array.isArray(value)) return value.map(expand);
 if (value.$ref) {
  const match = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(value.$ref);
  if (!match || !schemas.definitions[match[1]]) throw fault('INVALID_OWNER_SCHEMA');
  return expand(schemas.definitions[match[1]]);
 }
 return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}
const methods = new Map(Object.entries(methodMap.public).map(([method, pair]) =>
 ['transcription_' + method.replaceAll('.', '_'), {method, input:pair[0], output:pair[1]}]));

/** profile поступает от проверенного Auth; isAdmin перечитывает доверенную роль при settings.set. */
export function createOwnerTranscription(profile, endpoint, {isAdmin = async () => false, fetchImpl = fetch, timeoutMs = 12_000} = {}) {
 const scopeId = serviceDataScope(profile.profileId);
 if (typeof endpoint?.token !== 'string' || !endpoint.token || /\s/.test(endpoint.token) ||
     !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fault('INVALID_HERMES_CONFIG');
 const url = new URL(endpoint.url);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('INVALID_HERMES_CONFIG');
 url.pathname = '/internal/identity/transcription';
 const principal = {scopeType:'user', scopeId, ownerId:profile.userId, permissions:['transcription:use']};
 if (!validateDto('TrustedPrincipal', principal)) throw fault('INVALID_HERMES_CONFIG');
 return {
  list() {
   return [...methods].map(([name, entry]) => ({name, description:entry.method==='request.submit'
    ? 'Штатная расшифровка аудио Hermes. Передай ID готового личного аудиоартефакта. Скачанное медиа при необходимости приведи к mono WAV 16 кГц. Сохрани ключ и полученный requestId, затем проверь состояние и получи текст.'
    : 'Операция Transcription в личной области текущего профиля.',
    inputSchema:expand(schemas.definitions[entry.input])}));
  },
  async call(name, args = {}, signal) {
   const entry = methods.get(name);
   if (!entry || !validateDto(entry.input, args)) throw fault('INVALID_ARGUMENT');
   const trusted = {...principal, permissions:[...principal.permissions]};
   if (entry.method === 'settings.set') {
    if (await isAdmin() !== true) throw fault('FORBIDDEN');
    trusted.permissions.push('transcription:settings:write');
   }
   const body = JSON.stringify({method:entry.method, params:args, principal:trusted});
   if (Buffer.byteLength(body) > maxRequestBytes) throw fault('REQUEST_TOO_LARGE');
   if (signal?.aborted) throw fault('CANCELLED');
   const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
   let response;
   try {
    response = await fetchImpl(url, {method:'POST', redirect:'error', signal:abort,
     headers:{Authorization:'Bearer ' + endpoint.token, 'Content-Type':'application/json'}, body});
    if (!response.body) throw fault('INVALID_UPSTREAM_RESPONSE');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
     for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw fault('RESULT_TOO_LARGE');
      chunks.push(Buffer.from(value));
     }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result;
    try { result = JSON.parse(new TextDecoder('utf8', {fatal:true}).decode(Buffer.concat(chunks))); }
    catch { throw fault('INVALID_UPSTREAM_RESPONSE'); }
    if (!response.ok) {
     if (validateDto('ErrorResponse', result)) throw fault(result.errorCode);
     throw fault('INVALID_UPSTREAM_RESPONSE');
    }
    if (!validateDto(entry.output, result)) throw fault('INVALID_UPSTREAM_RESPONSE');
    return result;
   } catch (error) {
    const code = error?.code;
    const declared = schemas.definitions.ErrorCode.enum.includes(code) || uncertainErrors.has(code);
    // AIDEV-NOTE: HTTP сбой после submit может скрыть уже принятый запрос.
    // Не повторяем запись и не выдаём неизвестный исход за отказ до допуска.
    if (writeMethods.has(entry.method) && (!declared || uncertainErrors.has(code))) throw fault('OUTCOME_UNKNOWN');
    if (declared) throw error;
    throw fault(signal?.aborted ? 'CANCELLED' : abort.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_UNAVAILABLE');
   }
  },
 };
}
