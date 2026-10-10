// ABOUTME: Публикует и восстанавливает самостоятельные файлы через публичный API artifacts.
// ABOUTME: Сохраняет неизменяемые локальные копии; ограничивает память, размер и параллелизм.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, realpath, lstat, link, unlink, chmod } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Artifact } from '../../artifacts/contracts/index.mjs';
import { subjects } from '../../artifacts/contracts/index.mjs';

export const publisherMaxBytes = 2 * 1024 ** 3;
export type PublisherConfig = {
  ownerId: string; resultRoot: string; allowedReadRoots: string[];
  artifacts: { baseUrl: string; uploadBaseUrl?: string; timeoutMs?: number; nats: { servers: string[]; user?: string; password?: string; inboxPrefix?: string } };
  uploadTimeoutMs?: number;
};
export type PublisherPort = {
  request(subject: string, value: unknown, signal: AbortSignal): Promise<any>;
  fetch: typeof fetch;
};
export type PublishedFile = { artifactId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; localPath: string; markdown: string };
type Fingerprint = { sizeBytes: number; sha256: string; prefix: Buffer };
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeFilename(value: string): string {
  if (!value || value === '.' || value === '..' || basename(value) !== value || /[\\<>?#%\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255) fail('INVALID_FILENAME');
  return value;
}
function mime(prefix: Buffer, filename: string): string {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString())) return 'image/gif';
  if (prefix.subarray(0, 4).toString() === 'RIFF' && prefix.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (prefix.length >= 12 && prefix.subarray(4, 8).toString() === 'ftyp' && ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV'].includes(prefix.subarray(8, 12).toString())) return 'video/mp4';
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && prefix.includes(Buffer.from('webm'))) return 'video/webm';
  const extension = extname(filename).toLowerCase();
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
function inline(mimeType: string): boolean { return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'].includes(mimeType); }

/** Потоково считает SHA-256 и, при наличии target, пишет файл; принимает ровно 2 GiB. */
export async function streamPublisherFile(source: AsyncIterable<Uint8Array>, signal: AbortSignal, target?: Awaited<ReturnType<typeof open>>): Promise<Fingerprint> {
  const hash = createHash('sha256'); let sizeBytes = 0; let prefix = Buffer.alloc(0);
  for await (const chunk of source) {
    signal.throwIfAborted(); sizeBytes += chunk.byteLength;
    if (sizeBytes > publisherMaxBytes) fail('FILE_TOO_LARGE');
    hash.update(chunk);
    if (prefix.length < 512) prefix = Buffer.concat([prefix, Buffer.from(chunk.subarray(0, 512 - prefix.length))]);
    if (target) { let offset = 0; while (offset < chunk.length) { signal.throwIfAborted(); const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset); if (!bytesWritten) fail('LOCAL_WRITE_FAILED'); offset += bytesWritten; } }
  }
  signal.throwIfAborted(); return { sizeBytes, sha256: hash.digest('hex'), prefix };
}

/** Создаёт publisher для фиксированного владельца. Третий одновременный вызов получает OVERLOADED. */
export async function createPublisher(config: PublisherConfig, port: PublisherPort, trustedOwnerId: string) {
  if (!trustedOwnerId || config.ownerId !== trustedOwnerId || /\s/.test(config.ownerId) || [...config.ownerId].length > 128 || !config.allowedReadRoots?.length || !isAbsolute(config.resultRoot) || config.allowedReadRoots.some(path => !isAbsolute(path))) fail('INVALID_PUBLISHER_CONFIG');
  const base = new URL(config.artifacts.baseUrl), uploadBase = new URL(config.artifacts.uploadBaseUrl ?? config.artifacts.baseUrl);
  if (/[\\<>?#%\x00-\x1f\x7f]/.test(config.resultRoot) || [base, uploadBase].some(base => !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)) fail('INVALID_PUBLISHER_CONFIG');
  const timeout = config.uploadTimeoutMs ?? 1800000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 1800000) fail('INVALID_PUBLISHER_CONFIG');
  await mkdir(config.resultRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(config.resultRoot), roots = await Promise.all(config.allowedReadRoots.map(path => realpath(path)));
  if (root !== config.resultRoot) fail('INVALID_PUBLISHER_CONFIG');
  const active = new Set<Promise<PublishedFile>>(), controllers = new Set<AbortController>(); let stopped = false;

  async function run(work: (signal: AbortSignal) => Promise<PublishedFile>, caller?: AbortSignal): Promise<PublishedFile> {
    if (stopped) fail('STOPPING'); if (active.size >= 2) fail('OVERLOADED');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(caller ? [caller] : [])]);
    controllers.add(controller);
    const pending = work(signal); active.add(pending);
    try { return await pending; } finally { active.delete(pending); controllers.delete(controller); }
  }
  async function query(subject: string, value: unknown, signal: AbortSignal): Promise<any> {
    signal.throwIfAborted(); const result = await port.request(subject, value, signal); signal.throwIfAborted(); return result;
  }
  async function localFingerprint(path: string, signal: AbortSignal): Promise<Fingerprint> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await handle.stat()).isFile()) fail('INVALID_FILE'); return await streamPublisherFile(handle.createReadStream({ highWaterMark: 65536, autoClose: false, signal }), signal); }
    finally { await handle.close(); }
  }
  async function tempFrom(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Fingerprint & { path: string }> {
    const path = join(root, '.pending-' + randomUUID()), target = await open(path, 'wx', 0o600);
    try { const info = await streamPublisherFile(source, signal, target); await target.sync(); return { ...info, path }; }
    catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await target.close(); }
  }
  function owned(artifact: Artifact) { if (!uuid.test(artifact.artifactId) || artifact.ownerId !== config.ownerId) fail('FORBIDDEN'); }
  function ready(artifact: Artifact, info?: Fingerprint) {
    owned(artifact);
    if (artifact.status !== 'ready' || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes! < 0 || artifact.sizeBytes! > publisherMaxBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) fail('NOT_READY');
    if (info && (artifact.sizeBytes !== info.sizeBytes || artifact.sha256 !== info.sha256)) fail('HASH_MISMATCH');
    url(artifact.internalUrl, '/files/' + artifact.artifactId);
  }
  async function destination(artifact: Artifact): Promise<string> {
    owned(artifact); const dir = join(root, artifact.artifactId);
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) fail('UNSAFE_RESULT_PATH');
    return join(dir, safeFilename(artifact.filename));
  }
  async function install(temp: string, path: string, info: Fingerprint, signal: AbortSignal) {
    signal.throwIfAborted();
    try { await link(temp, path); await chmod(path, 0o444); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; const existing = await localFingerprint(path, signal); if (existing.sha256 !== info.sha256 || existing.sizeBytes !== info.sizeBytes) fail('LOCAL_CONTENT_CONFLICT'); }
  }
  function result(artifact: Artifact, localPath: string, info: Fingerprint): PublishedFile {
    ready(artifact, info); const label = artifact.filename.replace(/[\\[\]]/g, '\\$&');
    // AIDEV-NOTE: SVG/HTML и metadata с неподтверждённой сигнатурой никогда не становятся inline.
    const image = inline(artifact.mimeType) && mime(info.prefix, artifact.filename) === artifact.mimeType;
    return { artifactId: artifact.artifactId, filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: info.sizeBytes, sha256: info.sha256, localPath, markdown: `${image ? '!' : ''}[${label}](<${localPath}>)` };
  }
  function url(value: string | undefined, path: string, trustedBase = base): URL {
    const resolved = new URL(value ?? '');
    if (resolved.origin !== trustedBase.origin || resolved.username || resolved.password || resolved.search || resolved.hash || resolved.pathname !== trustedBase.pathname.replace(/\/$/, '') + path) fail('INVALID_ARTIFACT_URL');
    return resolved;
  }

  /** Публикует read-root файл. requestId закрепляет содержимое и metadata после перезапуска. */
  function publishFile(input: { path: string; requestId: string; title?: string }, caller?: AbortSignal) {
    return run(async signal => {
      if (!input || Object.keys(input).some(key => !['path', 'requestId', 'title'].includes(key)) || typeof input.path !== 'string' || !isAbsolute(input.path) || typeof input.requestId !== 'string' || !input.requestId.trim() || [...input.requestId].length > 256 || input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || [...input.title].length > 512)) fail('INVALID_ARGUMENT');
      const path = await realpath(input.path); if (!roots.some(root => inside(root, path))) fail('READ_ROOT_DENIED');
      const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let snapshot: Awaited<ReturnType<typeof tempFrom>> | undefined;
      try {
        const stat = await source.stat(); if (!stat.isFile()) fail('INVALID_FILE'); if (stat.size > publisherMaxBytes) fail('FILE_TOO_LARGE');
        // AIDEV-NOTE: Проверка открытого fd закрывает гонку подмены промежуточного каталога на Linux.
        const openedPath = process.platform === 'linux' ? await realpath(`/proc/self/fd/${source.fd}`) : await realpath(path);
        if (!roots.some(root => inside(root, openedPath))) fail('READ_ROOT_DENIED');
        snapshot = await tempFrom(source.createReadStream({ highWaterMark: 65536, autoClose: false, signal }), signal);
        const filename = safeFilename(basename(path)), requestId = 'brai:agent:publish:v1:' + createHash('sha256').update(JSON.stringify([config.ownerId, input.requestId])).digest('hex');
        const prepared = await query(subjects.prepare, { requestId, ownerId: config.ownerId, kind: 'original', metadata: { title: input.title ?? filename, filename, extension: extname(filename).slice(1), mimeType: mime(snapshot.prefix, filename), source: 'agent', details: { agentPublisher: { version: 1, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes } } } }, signal);
        owned(prepared.artifact); const fingerprint = prepared.artifact.details?.agentPublisher;
        if (fingerprint?.sha256 !== snapshot.sha256 || fingerprint?.sizeBytes !== snapshot.sizeBytes) fail('OPERATION_CONFLICT');
        const localPath = await destination(prepared.artifact); await install(snapshot.path, localPath, snapshot, signal);
        // AIDEV-NOTE: GET precedes every PUT, including a repeat after a lost acknowledgement.
        let artifact: Artifact = await query(subjects.get, { artifactId: prepared.artifact.artifactId }, signal);
        owned(artifact);
        if (artifact.status !== 'ready') {
          if (!['pending', 'failed'].includes(artifact.status)) fail('NOT_READY');
          const upload = new URL(prepared.uploadUrl);
          if (!/^\/upload\/[A-Za-z0-9_-]+$/.test(upload.pathname.slice(uploadBase.pathname.replace(/\/$/, '').length))) fail('INVALID_ARTIFACT_URL');
          url(upload.href, upload.pathname.slice(uploadBase.pathname.replace(/\/$/, '').length), uploadBase);
          const handle = await open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const body = handle.createReadStream({ highWaterMark: 65536, autoClose: false, signal });
            try {
              const response = await port.fetch(upload, { method: 'PUT', body: body as unknown as BodyInit, duplex: 'half', redirect: 'error', headers: { 'content-length': String(snapshot.sizeBytes), 'content-type': prepared.artifact.mimeType }, signal } as RequestInit);
              try {
                if (response.status !== 201 || response.headers.get('x-artifact-id') !== artifact.artifactId || response.headers.get('x-artifact-state') !== 'ready' || response.headers.get('x-artifact-size') !== String(snapshot.sizeBytes) || response.headers.get('x-artifact-sha256') !== snapshot.sha256) fail('UPLOAD_NOT_CONFIRMED');
                url(response.headers.get('location') ?? undefined, '/files/' + artifact.artifactId);
              } finally { await response.body?.cancel().catch(() => {}); }
            } catch (error) {
              signal.throwIfAborted();
              artifact = await query(subjects.get, { artifactId: artifact.artifactId }, signal); ready(artifact, snapshot);
              return result(artifact, localPath, snapshot);
            } finally { body.destroy(); }
          } finally { await handle.close(); }
          artifact = await query(subjects.get, { artifactId: artifact.artifactId }, signal);
        }
        return result(artifact, localPath, snapshot);
      } finally { await source.close(); if (snapshot) await unlink(snapshot.path).catch(() => {}); }
    }, caller);
  }
  /** Восстанавливает только собственный ready артефакт, сверяет поток с hash владельца. */
  function fetchFile(input: { artifactId: string }, caller?: AbortSignal) {
    return run(async signal => {
      if (!input || Object.keys(input).some(key => key !== 'artifactId') || typeof input.artifactId !== 'string' || !uuid.test(input.artifactId)) fail('INVALID_ARGUMENT');
      const artifact: Artifact = await query(subjects.get, input, signal); if (artifact.artifactId.toLowerCase() !== input.artifactId.toLowerCase()) fail('INVALID_ARTIFACT_RESPONSE'); ready(artifact);
      const localPath = await destination(artifact);
      try { const info = await localFingerprint(localPath, signal); return result(artifact, localPath, info); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const response = await port.fetch(url(artifact.internalUrl, '/files/' + artifact.artifactId), { redirect: 'error', signal });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); fail('DOWNLOAD_FAILED'); }
      let snapshot: Awaited<ReturnType<typeof tempFrom>> | undefined;
      try {
        snapshot = await tempFrom(Readable.fromWeb(response.body as any), signal); ready(artifact, snapshot); await install(snapshot.path, localPath, snapshot, signal); return result(artifact, localPath, snapshot);
      } finally { await response.body?.cancel().catch(() => {}); if (snapshot) await unlink(snapshot.path).catch(() => {}); }
    }, caller);
  }
  return { publishFile, fetchFile, async close() { stopped = true; for (const controller of controllers) controller.abort(new Error('STOPPING')); await Promise.allSettled([...active]); } };
}
