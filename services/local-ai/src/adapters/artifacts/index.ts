// ABOUTME: Получает готовое аудио из публичного artifacts API во временный файл.
// ABOUTME: Проверяет владельца и байты до передачи пути модели; удаляет только свои temp-файлы.
import { createHash } from 'node:crypto';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { NatsConnection } from 'nats';
import { ServiceErrorCodeHeader, ServiceErrorHeader } from 'nats';
import { LocalAiError } from '../../errors.js';
import type { ArtifactPort } from '../../ports.js';
import type { OperationContext, ServiceErrorCode } from '../../types.js';

export type ArtifactsAdapterConfig = {
  nats: NatsConnection;
  internalBaseUrl: string;
  tempRoot: string;
  maxAudioBytes: number;
  allowedMimeTypes: readonly string[];
};

type ArtifactReply = {
  artifactId: string;
  ownerId: string;
  status: string;
  mimeType?: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  internalUrl?: string;
};

type ReadyArtifactReply = ArtifactReply & {
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  internalUrl: string;
};

const GET_SUBJECT = 'brai.artifacts.v1.get';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const OPAQUE_KEY = /^[A-Za-z0-9._~-]+$/;

function fail(code: ServiceErrorCode): never {
  throw new LocalAiError(code, code, code === 'DEPENDENCY_UNAVAILABLE');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function cleanupOwned(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);
  }
}

function deadlineMs(context: OperationContext): number {
  const deadline = Date.parse(context.deadlineAt);
  if (!Number.isFinite(deadline)) fail('INVALID_ARGUMENT');
  const left = deadline - Date.now();
  if (left <= 0) fail('DEADLINE_EXCEEDED');
  return Math.max(1, Math.ceil(left));
}

function cancellationCode(context: OperationContext): ServiceErrorCode | undefined {
  if (Date.parse(context.deadlineAt) <= Date.now()) return 'DEADLINE_EXCEEDED';
  if (context.signal.aborted) return 'CANCELLED';
  return undefined;
}

function assertActive(context: OperationContext): void {
  const code = cancellationCode(context);
  if (code) fail(code);
  deadlineMs(context);
}

/** Останавливает ожидание по отмене или deadline, оставляя NATS timeout ограниченным сроком операции. */
async function waitForOperation<T>(promise: Promise<T>, context: OperationContext): Promise<T> {
  assertActive(context);
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new LocalAiError(cancellationCode(context) ?? 'CANCELLED', cancellationCode(context) ?? 'CANCELLED'));
    context.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (abortListener) context.signal.removeEventListener('abort', abortListener);
  }
}

function assertReadyFields(artifact: ArtifactReply): asserts artifact is ReadyArtifactReply {
  if (typeof artifact.mimeType !== 'string'
    || typeof artifact.sizeBytes !== 'number'
    || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 0
    || typeof artifact.sha256 !== 'string'
    || typeof artifact.internalUrl !== 'string') {
    fail('DEPENDENCY_UNAVAILABLE');
  }
}

function parseArtifact(data: Uint8Array): ArtifactReply {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    fail('DEPENDENCY_UNAVAILABLE');
  }
  if (!record(value)
    || typeof value.artifactId !== 'string'
    || typeof value.ownerId !== 'string'
    || typeof value.status !== 'string') {
    fail('DEPENDENCY_UNAVAILABLE');
  }
  return value as ArtifactReply;
}

async function getArtifact(
  nats: NatsConnection,
  artifactId: string,
  context: OperationContext,
): Promise<ArtifactReply> {
  let reply;
  try {
    const request = nats.request(
      GET_SUBJECT,
      Buffer.from(JSON.stringify({ artifactId })),
      { timeout: deadlineMs(context) },
    );
    reply = await waitForOperation(request, context);
  } catch (error) {
    if (error instanceof LocalAiError) throw error;
    const cancellation = cancellationCode(context);
    if (cancellation) fail(cancellation);
    fail('DEPENDENCY_UNAVAILABLE');
  }

  // Заголовки NATS Service проверяются до разбора тела ответа.
  const error = reply.headers?.get(ServiceErrorHeader);
  const status = reply.headers?.get(ServiceErrorCodeHeader);
  if (Boolean(error) !== Boolean(status) || status && !/^[45][0-9]{2}$/.test(status)) {
    fail('DEPENDENCY_UNAVAILABLE');
  }
  if (error) {
    if (status === '404') fail('ARTIFACT_NOT_AVAILABLE');
    fail('DEPENDENCY_UNAVAILABLE');
  }

  assertActive(context);
  return parseArtifact(reply.data);
}

function trustedFileUrl(value: string, base: URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('DEPENDENCY_UNAVAILABLE');
  }
  const match = url.pathname.match(/^\/files\/([^/]+)$/);
  const key = match?.[1];
  if (url.origin !== base.origin
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || value.includes('%')
    || value.includes('\\')
    || !key
    || key === '.'
    || key === '..'
    || !OPAQUE_KEY.test(key)
    || url.href !== value) {
    fail('DEPENDENCY_UNAVAILABLE');
  }
  return url;
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
  context: OperationContext,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    assertActive(context);
    const result = await file.write(chunk, offset, chunk.length - offset, null);
    if (result.bytesWritten <= 0) fail('DEPENDENCY_UNAVAILABLE');
    offset += result.bytesWritten;
  }
}

/** Скачивает во временную папку с ограниченным размером и сверяет объявленные size/hash. */
async function download(
  url: URL,
  artifact: ReadyArtifactReply,
  config: ArtifactsAdapterConfig,
  context: OperationContext,
): Promise<{ directory: string; localPath: string }> {
  assertActive(context);
  let directory: string | undefined;
  let localPath: string | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let response: Response | undefined;
  let retainDirectory = false;
  try {
    directory = await mkdtemp(join(config.tempRoot, 'local-ai-artifact-'));
    localPath = join(directory, 'audio');
    file = await open(localPath, 'wx', 0o600);
    try {
      response = await fetch(url, { method: 'GET', redirect: 'manual', signal: context.signal });
    } catch {
      const cancellation = cancellationCode(context);
      if (cancellation) fail(cancellation);
      fail('DEPENDENCY_UNAVAILABLE');
    }
    if (response.status === 404) fail('ARTIFACT_NOT_AVAILABLE');
    if (response.status !== 200 || !response.body) fail('DEPENDENCY_UNAVAILABLE');

    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      while (true) {
        assertActive(context);
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } catch {
          const cancellation = cancellationCode(context);
          if (cancellation) fail(cancellation);
          fail('DEPENDENCY_UNAVAILABLE');
        }
        if (part.done) break;
        const chunk = Buffer.from(part.value);
        bytes += chunk.byteLength;
        if (bytes > config.maxAudioBytes) fail('INPUT_TOO_LARGE');
        hash.update(chunk);
        await writeAll(file, chunk, context);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof LocalAiError) throw error;
      const cancellation = cancellationCode(context);
      if (cancellation) fail(cancellation);
      fail('DEPENDENCY_UNAVAILABLE');
    }
    if (bytes !== artifact.sizeBytes || hash.digest('hex') !== artifact.sha256.toLowerCase()) {
      fail('DEPENDENCY_UNAVAILABLE');
    }
    assertActive(context);
    await file.close();
    file = undefined;
    retainDirectory = true;
    return { directory, localPath };
  } catch (error) {
    if (error instanceof LocalAiError) throw error;
    const cancellation = cancellationCode(context);
    if (cancellation) throw new LocalAiError(cancellation, cancellation);
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', true);
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
    await file?.close().catch(() => undefined);
    // Удаляется только каталог, который вернул этот вызов mkdtemp.
    if (directory && !retainDirectory) await cleanupOwned(directory);
  }
}

/** Создаёт порт, удерживающий проверенный temp-файл только пока исполняется callback. */
export function createArtifactsAdapter(config: ArtifactsAdapterConfig): ArtifactPort {
  let base: URL;
  try {
    base = new URL(config.internalBaseUrl);
  } catch {
    fail('INVALID_ARGUMENT');
  }
  if (!['http:', 'https:'].includes(base.protocol)
    || base.username !== ''
    || base.password !== ''
    || base.search !== ''
    || base.hash !== ''
    || base.pathname !== '/'
    || !isAbsolute(config.tempRoot)
    || !Number.isSafeInteger(config.maxAudioBytes)
    || config.maxAudioBytes < 1
    || !Array.isArray(config.allowedMimeTypes)
    || config.allowedMimeTypes.length === 0
    || config.allowedMimeTypes.some((mime) => typeof mime !== 'string' || mime.length === 0)) {
    fail('INVALID_ARGUMENT');
  }
  const allowedMimeTypes = new Set(config.allowedMimeTypes);

  return {
    async withReadyAudio(input, context, use) {
      if (!UUID.test(input.artifactId)
        || input.ownerId !== context.ownerId
        || typeof input.operationId !== 'string'
        || input.operationId.length === 0
        || input.operationId !== context.operationId
        || typeof use !== 'function') {
        fail('INVALID_ARGUMENT');
      }
      assertActive(context);
      const artifact = await getArtifact(config.nats, input.artifactId, context);
      if (!UUID.test(artifact.artifactId)
        || artifact.artifactId.toLowerCase() !== input.artifactId.toLowerCase()
        || artifact.ownerId !== context.ownerId
        || artifact.status !== 'ready') {
        fail('ARTIFACT_NOT_AVAILABLE');
      }
      if (typeof artifact.mimeType !== 'string' || !allowedMimeTypes.has(artifact.mimeType)) {
        fail('ARTIFACT_NOT_AVAILABLE');
      }
      assertReadyFields(artifact);
      if (artifact.sizeBytes > config.maxAudioBytes) fail('INPUT_TOO_LARGE');
      if (!SHA256.test(artifact.sha256)) fail('DEPENDENCY_UNAVAILABLE');
      const url = trustedFileUrl(artifact.internalUrl, base);
      const temp = await download(url, artifact, config, context);
      try {
        assertActive(context);
        return await use({ localPath: temp.localPath });
      } finally {
        await cleanupOwned(temp.directory);
      }
    },
  };
}
