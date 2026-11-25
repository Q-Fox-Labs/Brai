// ABOUTME: Вызывает Transcription через Root delegation для проверенного личного профиля.
// ABOUTME: Bearer остаётся в Root; worker передаёт только публичные owner DTO.
import { execFile } from 'node:child_process';
import { methodMap, schemas, validateDto } from '../../transcription/contracts/index.mjs';
import { serviceDataScope } from '../../auth/contracts/service-data-scope.mjs';
import { fault } from '../runtime.mjs';

const maxRequestBytes = 65_536, maxResponseBytes = 1_048_576;
const writeMethods = new Set(['request.submit', 'request.cancel', 'settings.set']);
const uncertainErrors = new Set(['DEADLINE_EXCEEDED', 'CANCELLED', 'INVALID_UPSTREAM_RESPONSE', 'RESULT_TOO_LARGE',
 'UPSTREAM_UNAVAILABLE', 'REQUEST_OUTCOME_UNKNOWN', 'STORAGE_UNAVAILABLE', 'INTERNAL']);
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

const releaseContainer = 'brai-release-transcription';
const releaseNetworks = 'brai_release_database_private,brai_release_nats_private';
const releaseOrigin = 'http://brai-release-transcription:19342';
const inspectFields = [
 '.Id', '.Name', '.Image', '.State.Running', '.State.Health.Status',
 '.Config.User', '.Config.Labels', '.Config.Entrypoint', '.Config.Cmd', '.Mounts',
 '.NetworkSettings.Networks', '.HostConfig.PortBindings', '.HostConfig.ReadonlyRootfs',
].map(field => '{{json ' + field + '}}').join('\n');

function releaseDocker(args, {signal, input, maxBuffer}, launch = execFile) {
 return new Promise((resolve, reject) => {
  const child = launch('/usr/bin/docker', ['--host=unix:///run/docker.sock', ...args], {
   signal, encoding:'buffer', maxBuffer,
   env:{PATH:'/usr/bin:/bin', DOCKER_CONFIG:'/run/brai-hermes-release-identity/docker-cli'},
  }, (error, output) => error ? reject(error) : resolve(output));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
 });
}

const releaseRequest = `
const deadlineAt=Number(process.argv[1]), maxBytes=${maxResponseBytes};
const input=[];
let inputSize=0;
const inputTimeout=setTimeout(()=>process.stdin.destroy(Error('DEADLINE_EXCEEDED')),Math.max(1,deadlineAt-Date.now()));
try {
 for await (const chunk of process.stdin) {
  inputSize+=chunk.length;
  if(inputSize>${maxRequestBytes+65})throw Error('REQUEST_TOO_LARGE');
  input.push(chunk);
 }
} finally {clearTimeout(inputTimeout);}
const request=Buffer.concat(input);
if(request[64]!==10)throw Error('INVALID_ARGUMENT');
const token=request.subarray(0,64).toString(), body=request.subarray(65);
const remaining=deadlineAt-Date.now();
if(remaining<=0)throw Error('DEADLINE_EXCEEDED');
const response=await fetch('http://127.0.0.1:19342/internal/identity/transcription',{
 method:'POST', redirect:'error', signal:AbortSignal.timeout(remaining),
 headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body,
});
const reader=response.body.getReader();
const chunks=[];
let size=0;
try {
 for (;;) {
  const {done,value}=await reader.read();
  if(done)break;
  size+=value.byteLength;
  if(size>maxBytes)throw Error('RESULT_TOO_LARGE');
  chunks.push(Buffer.from(value));
 }
} finally {await reader.cancel().catch(()=>{});}
process.stdout.write(Buffer.concat([Buffer.from(String(response.status)+'\\n'),...chunks]));
`;

/** Resolve each invocation to the exact running container ID before giving it a credential. */
function releaseTransport(endpoint, docker) {
 const source = endpoint.releaseContainer;
 if (!source || Object.keys(source).sort().join(',') !== 'imageId,packageDigest'
     || !/^sha256:[a-f0-9]{64}$/.test(source.imageId) || !/^[a-f0-9]{64}$/.test(source.packageDigest)
     || !/^[a-f0-9]{64}$/.test(endpoint.token)
     || endpoint.url !== releaseOrigin) throw fault('INVALID_HERMES_CONFIG');
 const program = '/opt/brai-components/release/transcription/' + source.packageDigest;
 async function resolve(signal) {
  const raw = await docker(['inspect','--type','container','--format',inspectFields,releaseContainer],
   {signal,maxBuffer:maxRequestBytes});
  const [id,name,image,running,health,user,labels,entrypoint,command,mounts,networks,ports,readonly] =
   raw.toString().trimEnd().split('\n').map(JSON.parse);
  const workspace = mounts.filter(mount => mount.Destination === '/workspace');
  const runner = mounts.filter(mount => mount.Destination === '/run/transcription.mjs');
  if (!/^[a-f0-9]{64}$/.test(id) || name !== '/'+releaseContainer || image !== source.imageId
      || running !== true || health !== 'healthy' || user !== '1000:1000' || readonly !== true
      || labels['com.docker.compose.project'] !== 'brai-release-diary'
      || labels['com.docker.compose.service'] !== 'transcription'
      || entrypoint?.length !== 1 || entrypoint[0] !== '/usr/local/bin/node'
      || command?.length !== 1 || command[0] !== '/run/transcription.mjs'
      || mounts?.length !== 2 || workspace.length !== 1 || runner.length !== 1
      || workspace[0].Source !== program || runner[0].Source !== '/etc/brai-release/personal-services/transcription/run-v2.mjs'
      || mounts.some(mount => mount.Type !== 'bind' || mount.RW !== false)
      || Object.keys(networks).sort().join(',') !== releaseNetworks
      || Object.keys(ports || {}).length > 0) throw fault('UPSTREAM_UNAVAILABLE');
  return id;
 }
 async function request(id, body, signal, deadlineAt) {
  const raw = await docker(['exec','-i','--user','1000:1000',id,
   '/usr/local/bin/node','--input-type=module','-e',releaseRequest,String(deadlineAt)],
   {signal,maxBuffer:maxResponseBytes+4,input:endpoint.token+'\n'+body});
  const boundary = raw.indexOf(10);
  const status = Number(raw.subarray(0,boundary).toString());
  if (boundary !== 3 || !Number.isSafeInteger(status) || status < 200 || status > 599) throw fault('INVALID_UPSTREAM_RESPONSE');
  return new Response(raw.subarray(boundary+1), {status});
 }
 return {resolve,request};
}

/** profile поступает от проверенного Auth; isAdmin перечитывает доверенную роль при settings.set. */
export function createOwnerTranscription(profile, endpoint, {
 isAdmin = async () => false, fetchImpl = fetch, timeoutMs = 12_000, docker = releaseDocker,
} = {}) {
 const scopeId = serviceDataScope(profile.profileId);
 if (typeof endpoint?.token !== 'string' || !endpoint.token || /\s/.test(endpoint.token) ||
     !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fault('INVALID_HERMES_CONFIG');
 const url = new URL(endpoint.url);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('INVALID_HERMES_CONFIG');
 url.pathname = '/internal/identity/transcription';
 const release = endpoint.releaseContainer === undefined ? null : releaseTransport(endpoint, docker);
 const principal = {scopeType:'user', scopeId, ownerId:profile.userId, permissions:['transcription:use']};
 if (!validateDto('TrustedPrincipal', principal)) throw fault('INVALID_HERMES_CONFIG');
 return {
  list() {
   return [...methods].filter(([,entry]) => !release || entry.method!=='settings.set')
    .map(([name, entry]) => ({name, description:entry.method==='request.submit'
    ? 'Штатная расшифровка аудио Hermes. Передай ID готового личного аудиоартефакта. Скачанное медиа при необходимости приведи к mono WAV 16 кГц. Сохрани ключ и полученный requestId, затем проверь состояние и получи текст.'
    : 'Операция Transcription в личной области текущего профиля.',
    inputSchema:expand(schemas.definitions[entry.input])}));
  },
  async call(name, args = {}, signal) {
   const entry = methods.get(name);
   if (!entry || !validateDto(entry.input, args)) throw fault('INVALID_ARGUMENT');
   const trusted = {...principal, permissions:[...principal.permissions]};
   if (entry.method === 'settings.set') {
    if (release || await isAdmin() !== true) throw fault('FORBIDDEN');
    trusted.permissions.push('transcription:settings:write');
   }
   const body = JSON.stringify({method:entry.method, params:args, principal:trusted});
   if (Buffer.byteLength(body) > maxRequestBytes) throw fault('REQUEST_TOO_LARGE');
   if (signal?.aborted) throw fault('CANCELLED');
   const deadlineAt = Date.now() + timeoutMs;
   const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
   let container;
   if (release) {
    try {
     container = await release.resolve(abort);
     abort.throwIfAborted();
    } catch {
     throw fault(signal?.aborted ? 'CANCELLED' : abort.aborted ? 'DEADLINE_EXCEEDED' : 'UPSTREAM_UNAVAILABLE');
    }
   }
   let response;
   try {
    response = release ? await release.request(container, body, abort, deadlineAt)
     : await fetchImpl(url, {method:'POST', redirect:'error', signal:abort,
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
