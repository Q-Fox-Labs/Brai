// ABOUTME: Предоставляет MemOS OpenAI-совместимый HTTP интерфейс для эмбеддингов LocalAI.
// ABOUTME: Передаёт только текстовые batch-запросы в публичный NATS invoke.embed.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'nats';

const MODEL_ID = 'embeddinggemma-2-q8';
const MODEL_REVISION = 'bfcd298762cc34d0357ece5ebdd31791a3a374d8';
const PROFILE_ID = 'embeddinggemma2_llama_cpp';
const DIMENSIONS = 768;
const SUBJECT = 'brai.local_ai.v1.invoke.embed';
const MAX_BODY_BYTES = 1024 * 1024;

/** Read and validate the protected Hermes configuration without logging its contents. */
export async function loadConfig(configPath = process.env.BRAI_HERMES_CONFIG) {
  if (!configPath) throw new Error('BRAI_HERMES_CONFIG is required');
  const value = JSON.parse(await readFile(configPath, 'utf8'));
  return validateConfig(value);
}

/** Validate owner, DEV NATS endpoint, pinned model, and listener settings. */
export function validateConfig(value) {
  const nats = value?.nats;
  const embedding = value?.embedding;
  const model = embedding?.model;
  if (!value?.ownerId || (process.env.BRAI_HERMES_OWNER_ID && process.env.BRAI_HERMES_OWNER_ID !== value.ownerId)) {
    throw new Error('Invalid Hermes owner configuration');
  }
  if (!Array.isArray(nats?.servers) || nats.servers.length === 0
    || !nats.servers.every(isDevNatsServer)
    || (nats.user && !nats.password) || (!nats.user && nats.password)) {
    throw new Error('Hermes NATS servers must target the DEV loopback listener on port 4223');
  }
  if (model?.modelId !== MODEL_ID || model?.revision !== MODEL_REVISION || model?.profileId !== PROFILE_ID) {
    throw new Error('Hermes embedding model must match the pinned LocalAI profile');
  }
  const host = embedding.host ?? '127.0.0.1';
  const port = embedding.port ?? 19363;
  const timeoutMs = embedding.timeoutMs ?? 120_000;
  const apiKey = embedding.apiKey;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length < 32))
    || (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && !apiKey)) {
    throw new Error('Invalid Hermes embedding listener configuration');
  }
  return { ownerId: value.ownerId, nats: { ...nats }, embedding: { host, port, timeoutMs, apiKey, model: { modelId: MODEL_ID, revision: MODEL_REVISION, profileId: PROFILE_ID } } };
}

function isDevNatsServer(server) {
  if (typeof server !== 'string') return false;
  try {
    const url = new URL(server);
    return ['nats:', 'tls:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
      && url.port === '4223'
      && (url.pathname === '' || url.pathname === '/')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function httpError(status, code, message = code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** Validate OpenAI embeddings input and create the fixed LocalAI invocation. */
export function buildInvocation(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_request', 'An object is required');
  if (body.model !== MODEL_ID) throw httpError(400, 'model_mismatch', 'This adapter serves embeddinggemma-2-q8 only');
  if (Object.keys(body).some((key) => !['model', 'input', 'dimensions', 'encoding_format'].includes(key))) {
    throw httpError(400, 'unsupported_parameter', 'Unsupported embeddings parameter');
  }
  if (body.dimensions !== undefined && body.dimensions !== DIMENSIONS) {
    throw httpError(400, 'invalid_request', 'Only 768-dimensional embeddings are supported');
  }
  if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) {
    throw httpError(400, 'invalid_request', 'Only float or base64 embeddings are supported');
  }
  const texts = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(texts) || texts.length === 0 || !texts.every((text) => typeof text === 'string')) {
    throw httpError(400, 'invalid_request', 'input must be a string or a non-empty array of strings');
  }
  return {
    requestId: randomUUID(),
    operationId: randomUUID(),
    model: config.embedding.model,
    ownerId: config.ownerId,
    deadlineAt: new Date(Date.now() + config.embedding.timeoutMs).toISOString(),
    texts,
    purpose: 'symmetric',
  };
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw httpError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

function authorized(request, apiKey) {
  if (!apiKey) return true;
  const header = request.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function safeNatsFailure(error) {
  const code = error?.code === 'TIMEOUT' || error?.name === 'TimeoutError' ? 'local_ai_timeout' : 'local_ai_unavailable';
  return httpError(503, code, 'LocalAI embedding request failed');
}

/** Handle one JSON body and return an HTTP result without opening a socket. */
export async function handleEmbedding(body, config, invokeEmbedding) {
  try {
    const invocation = buildInvocation(body, config);
    let result;
    try {
      result = await invokeEmbedding(invocation);
    } catch (error) {
      throw safeNatsFailure(error);
    }
    if (result?.requestId !== invocation.requestId || result?.operationId !== invocation.operationId
      || result?.model?.modelId !== MODEL_ID || result?.model?.revision !== MODEL_REVISION
      || result?.model?.profileId !== PROFILE_ID) {
      throw httpError(502, 'local_ai_model_mismatch', 'LocalAI returned a different model or request');
    }
    if (!Array.isArray(result?.vectors) || result.vectors.length !== invocation.texts.length
      || result.vectors.some((vector) => !Array.isArray(vector) || vector.length !== DIMENSIONS
        || !vector.every((item) => typeof item === 'number' && Number.isFinite(item)))) {
      throw httpError(502, 'invalid_local_ai_response', 'LocalAI returned an invalid embedding response');
    }
    const data = result.vectors.map((vector, index) => {
      let embedding = vector;
      if (body.encoding_format === 'base64') {
        // AIDEV-NOTE: Python OpenAI SDK по умолчанию просит base64 и декодирует float32.
        const bytes = Buffer.alloc(DIMENSIONS * 4);
        vector.forEach((value, position) => {
          if (!Number.isFinite(Math.fround(value))) {
            throw httpError(502, 'invalid_local_ai_response', 'LocalAI returned an invalid embedding response');
          }
          bytes.writeFloatLE(value, position * 4);
        });
        embedding = bytes.toString('base64');
      }
      return { object: 'embedding', index, embedding };
    });
    return {
      status: 200,
      body: {
        object: 'list',
        model: MODEL_ID,
        data,
      },
    };
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = error?.code ?? 'internal_error';
    return {
      status,
      body: { error: { message: error?.message ?? 'Internal error', type: status >= 500 ? 'server_error' : 'invalid_request_error', code } },
    };
  }
}

/** Create the HTTP adapter around an injected NATS invoke, suitable for isolated tests. */
export function createEmbeddingServer(config, invokeEmbedding, isReady = () => true) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      const ready = isReady();
      return json(response, ready ? 200 : 503, { status: ready ? 'ok' : 'unavailable', model: MODEL_ID, dimensions: DIMENSIONS });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/embeddings') {
      return json(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
    }
    if (!authorized(request, config.embedding.apiKey)) {
      return json(response, 401, { error: { message: 'Invalid adapter credentials', type: 'authentication_error', code: 'unauthorized' } });
    }
    try {
      const result = await handleEmbedding(await readJson(request), config, invokeEmbedding);
      return json(response, result.status, result.body);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = error?.code ?? 'internal_error';
      return json(response, status, { error: { message: error?.message ?? 'Internal error', type: status >= 500 ? 'server_error' : 'invalid_request_error', code } });
    }
  });
}

export async function startEmbeddingAdapter(config) {
  const nc = await connect({
    servers: config.nats.servers,
    user: config.nats.user,
    pass: config.nats.password,
    inboxPrefix: config.nats.inboxPrefix ?? '_INBOX.memos_embedding',
    timeout: 5_000,
    name: 'memos_embedding_adapter',
  });
  const server = createEmbeddingServer(config, async (invocation) => {
    const message = await nc.request(SUBJECT, Buffer.from(JSON.stringify(invocation)), { timeout: config.embedding.timeoutMs });
    const status = message.headers?.get('Nats-Service-Error-Code');
    if (status) {
      const error = new Error(message.headers?.get('Nats-Service-Error') ?? 'LocalAI request failed');
      error.code = status;
      throw error;
    }
    return JSON.parse(new TextDecoder().decode(message.data));
  }, () => !nc.isClosed() && !nc.isDraining());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.embedding.port, config.embedding.host, resolve);
  });
  const close = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await nc.drain();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  return { close, server, nc };
}

async function healthCheck(config) {
  const response = await fetch(`http://${config.embedding.host.includes(':') ? `[${config.embedding.host}]` : config.embedding.host}:${config.embedding.port}/health`, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json();
  if (!response.ok || body.model !== MODEL_ID || body.dimensions !== DIMENSIONS) throw new Error('Embedding adapter health check failed');
  process.stdout.write(JSON.stringify({ status: body.status, model: body.model, dimensions: body.dimensions }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await loadConfig();
    if (process.argv.includes('--health')) await healthCheck(config);
    else await startEmbeddingAdapter(config);
  } catch (error) {
    process.stderr.write(`MemOS embedding adapter: ${error.message}\n`);
    process.exitCode = 1;
  }
}
