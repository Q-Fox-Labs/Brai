// ABOUTME: Запускает два закреплённых local-ai runtime и переводит их протоколы в порты приложения.
// ABOUTME: Аргументы передаются напрямую; сеть, веса, пути и числовые лимиты поступают из конфигурации.
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RuntimeFactory, RuntimePort } from '../ports.js';
import { LocalAiError } from '../errors.js';
import type { EmbedInput, EmbedOutput, OperationContext, ResolvedModel, TranscribeInput, TranscribeOutput } from '../types.js';

type ProfileConfig = {
  executable: string;
  cwd: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  stopGraceMs: number;
  maxLineBytes: number;
};
export type ProfileRuntimeFactoryConfig = {
  profiles: {
    llama_cpp: ProfileConfig & { host: string; port: () => number; dimensions: number; contextTokens: number; maxBatchTokens: number; queryInstruction: string };
    gigaam_pytorch: ProfileConfig & { vadModelPath: string; vadRevision: string; threads: number; longformMaximumSeconds: number; audioDecodeTimeoutSeconds: number };
  };
  fetch?: typeof fetch;
};

type RpcReply = { jsonrpc: '2.0'; id: string; result?: unknown; error?: { code: number; message: string } };
type RpcWaiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; signal: AbortSignal; abort: () => void; method: string; startedAt: number };

function serviceError(code: ConstructorParameters<typeof LocalAiError>[0], message: string = code): LocalAiError {
  return new LocalAiError(code, message, code === 'ENGINE_UNAVAILABLE' || code === 'DEPENDENCY_UNAVAILABLE');
}

function remaining(context: OperationContext): number {
  const value = Date.parse(context.deadlineAt) - Date.now();
  if (!Number.isFinite(value) || value <= 0) throw serviceError('DEADLINE_EXCEEDED');
  if (context.signal.aborted) throw serviceError('CANCELLED');
  return Math.max(1, Math.ceil(value));
}

function checkContext(context: OperationContext): void { remaining(context); }

function modelPath(model: ResolvedModel, suffix: string): string {
  const path = join(model.installation.directory, suffix);
  if (!model.installation.files.some(file => file.path === suffix)) throw serviceError('MODEL_NOT_INSTALLED');
  return path;
}

function substitute(args: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return args.map(arg => {
    const value = arg.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => {
      const replacement = values[key];
      if (replacement === undefined) throw serviceError('MODEL_LOAD_FAILED', 'PROFILE_ARGUMENT_UNAVAILABLE');
      return replacement;
    });
    if (value.includes('{{') || value.includes('}}')) throw serviceError('MODEL_LOAD_FAILED', 'PROFILE_ARGUMENT_UNAVAILABLE');
    return value;
  });
}

type SpawnedRuntime = { child: ChildProcess; exited: Promise<void>; stop: () => Promise<void> };
type SpawnRuntimeOptions = {
  executor: 'llama_cpp' | 'gigaam_pytorch';
  privateTempDirectory?: string;
  cleanupAfterGroupExit?: () => Promise<void>;
};
type PrivateTempDirectory = { path: string; device: number; inode: number };

function diagnostic(operation: string, stage: string, executor: string, code: string, durationMs: number, child?: ChildProcess): void {
  try {
    process.stderr.write(JSON.stringify({ operation, stage, executor, code, durationMs: Math.max(0, Math.floor(durationMs)),
      ...(child ? { exitCode: child.exitCode, signal: child.signalCode } : {}),
    }) + '\n');
  } catch { /* Диагностика не меняет владение процессом. */ }
}

async function createGigaPrivateTempDirectory(): Promise<PrivateTempDirectory> {
  const parent = process.env.TMPDIR;
  if (!parent || !isAbsolute(parent)) throw serviceError('MODEL_LOAD_FAILED', 'TMPDIR_UNAVAILABLE');
  let path: string | undefined;
  try {
    path = await mkdtemp(join(parent, 'brai-local-ai-giga-'));
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o7777) !== 0o700) {
      throw serviceError('MODEL_LOAD_FAILED', 'TMPDIR_UNAVAILABLE');
    }
    return { path, device: directory.dev, inode: directory.ino };
  } catch {
    if (path) {
      try { await rm(path, { recursive: true, force: true }); }
      catch { throw serviceError('DEPENDENCY_UNAVAILABLE', 'TMPDIR_CLEANUP_UNCONFIRMED'); }
    }
    throw serviceError('MODEL_LOAD_FAILED', 'TMPDIR_UNAVAILABLE');
  }
}

async function removeGigaPrivateTempDirectory(directory: PrivateTempDirectory): Promise<void> {
  let current;
  try { current = await lstat(directory.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw serviceError('ENGINE_UNAVAILABLE', 'PROCESS_GROUP_EXIT_UNCONFIRMED');
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== directory.device || current.ino !== directory.inode) {
    throw serviceError('ENGINE_UNAVAILABLE', 'PROCESS_GROUP_EXIT_UNCONFIRMED');
  }
  await rm(directory.path, { recursive: true, force: false });
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function waitGroupGone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return !groupExists(pid);
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

function validateProfileConfig(config: ProfileConfig): void {
  for (const [name, value] of Object.entries({ startupTimeoutMs: config.startupTimeoutMs, requestTimeoutMs: config.requestTimeoutMs, stopGraceMs: config.stopGraceMs, maxLineBytes: config.maxLineBytes })) {
    if (!Number.isSafeInteger(value) || value < (name === 'stopGraceMs' ? 0 : 1)) throw serviceError('MODEL_LOAD_FAILED', 'INVALID_RUNTIME_LIMIT');
  }
}

function spawnRuntime(config: ProfileConfig, args: readonly string[], options: SpawnRuntimeOptions): SpawnedRuntime {
  const startedAt = Date.now();
  const env = {
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    ...config.env,
  };
  if (options.privateTempDirectory) {
    env.TMPDIR = options.privateTempDirectory;
    env.TMP = options.privateTempDirectory;
    env.TEMP = options.privateTempDirectory;
  }
  const child = spawn(config.executable, [...args], {
    cwd: config.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: true,
    windowsHide: true,
  });
  child.stderr?.resume();
  let exitResolve!: () => void;
  let parentClosedResolve!: () => void;
  const exited = new Promise<void>(resolve => { exitResolve = resolve; });
  const parentClosed = new Promise<void>(resolve => { parentClosedResolve = resolve; });
  const pid = child.pid;
  let didCloseParent = false;
  let didConfirmExit = false;
  let cleanupAfterExit: Promise<void> | undefined;
  let monitorTimer: NodeJS.Timeout | undefined;
  const confirmExit = (): boolean => {
    if (didConfirmExit) return true;
    if (!didCloseParent || pid !== undefined && groupExists(pid)) return false;
    // AIDEV-NOTE: Физический выход и результат очистки независимы; ошибка файлов не удерживает exited.
    didConfirmExit = true;
    if (monitorTimer) clearTimeout(monitorTimer);
    monitorTimer = undefined;
    exitResolve();
    diagnostic('runtime', 'group_exit', options.executor, 'EXIT_CONFIRMED', Date.now() - startedAt, child);
    return true;
  };
  const monitorExit = (): void => {
    if (didConfirmExit || monitorTimer) return;
    if (confirmExit()) return;
    monitorTimer = setTimeout(() => {
      monitorTimer = undefined;
      if (!confirmExit()) monitorExit();
    }, 50);
    // AIDEV-NOTE: После выхода parent оставшиеся descendants удерживают процесс сервиса до group proof.
  };
  const awaitConfirmedExit = async (): Promise<void> => {
    if (confirmExit()) return;
    let timer: NodeJS.Timeout | undefined;
    const confirmed = await Promise.race([exited.then(() => true), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), config.stopGraceMs);
      timer.unref();
    })]).finally(() => { if (timer) clearTimeout(timer); });
    if (!confirmed) throw serviceError('ENGINE_UNAVAILABLE', 'PROCESS_GROUP_EXIT_UNCONFIRMED');
  };
  let stopping: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupAfterExit) return cleanupAfterExit;
    cleanupAfterExit = (async () => {
      if (!options.cleanupAfterGroupExit) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(options.cleanupAfterGroupExit),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(serviceError('DEPENDENCY_UNAVAILABLE', 'TMPDIR_CLEANUP_TIMEOUT')), Math.max(1, config.stopGraceMs));
          }),
        ]);
      } catch {
        diagnostic('cleanup', 'temporary_directory', options.executor, 'TMPDIR_CLEANUP_UNCONFIRMED', Date.now() - startedAt, child);
        throw serviceError('DEPENDENCY_UNAVAILABLE', 'TMPDIR_CLEANUP_UNCONFIRMED');
      } finally { if (timer) clearTimeout(timer); }
    })();
    return cleanupAfterExit;
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!pid) { await parentClosed; await awaitConfirmedExit(); await cleanup(); return; }
      signalGroup(pid, 'SIGTERM');
      if (!await waitGroupGone(pid, config.stopGraceMs)) {
        signalGroup(pid, 'SIGKILL');
        if (!await waitGroupGone(pid, config.stopGraceMs)) throw serviceError('ENGINE_UNAVAILABLE', 'PROCESS_GROUP_EXIT_UNCONFIRMED');
      }
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([parentClosed.then(() => true), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), config.stopGraceMs);
        timer.unref();
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (!closed) throw serviceError('ENGINE_UNAVAILABLE', 'PROCESS_EXIT_UNCONFIRMED');
      await awaitConfirmedExit();
      await cleanup();
    })().catch(error => {
      const safeCodes = ['PROCESS_GROUP_EXIT_UNCONFIRMED', 'PROCESS_EXIT_UNCONFIRMED', 'TMPDIR_CLEANUP_UNCONFIRMED'];
      diagnostic('stop', 'process_group', options.executor, error instanceof LocalAiError && safeCodes.includes(error.message) ? error.message : 'ENGINE_UNAVAILABLE', Date.now() - startedAt, child);
      throw error;
    });
    return stopping;
  };
  child.once('close', () => {
    didCloseParent = true;
    parentClosedResolve();
    monitorExit();
    if (!stopping) void stop().catch(() => undefined);
  });
  child.once('error', error => {
    const errno = (error as NodeJS.ErrnoException).code;
    diagnostic('start', 'spawn', options.executor, errno && ['ENOENT', 'EACCES', 'ENOMEM', 'EAGAIN'].includes(errno) ? errno : 'SPAWN_FAILED', Date.now() - startedAt, child);
    // close остаётся единственным подтверждением завершения parent.
  });
  return { child, exited, stop };
}

function assertRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertVectors(value: unknown, count: number, dimensions: number): EmbedOutput {
  if (!assertRecord(value) || !Array.isArray(value.data) || value.data.length !== count) throw serviceError('ENGINE_UNAVAILABLE');
  const ordered: (readonly number[])[] = new Array(count);
  for (let position = 0; position < value.data.length; position++) {
    const row = value.data[position];
    if (!assertRecord(row) || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= count
      || ordered[row.index as number] !== undefined || !Array.isArray(row.embedding)
      || row.embedding.length !== dimensions || !row.embedding.every(item => typeof item === 'number' && Number.isFinite(item))) {
      throw serviceError('ENGINE_UNAVAILABLE');
    }
    const vector = row.embedding as number[];
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) throw serviceError('ENGINE_UNAVAILABLE');
    ordered[row.index as number] = vector;
  }
  return { vectors: ordered };
}

class ChildRuntime implements RuntimePort {
  readonly exited: Promise<void>;
  #child: ChildProcess;
  #config: ProfileRuntimeFactoryConfig['profiles']['gigaam_pytorch'];
  #closePromise?: Promise<void>;
  #stop: () => Promise<void>;
  #stdoutBuffer = Buffer.alloc(0);
  #waiters = new Map<string, RpcWaiter>();
  #nextId = 0;

  constructor(child: ChildProcess, exited: Promise<void>, config: ProfileRuntimeFactoryConfig['profiles']['gigaam_pytorch'], stop: () => Promise<void>) {
    this.#child = child;
    this.exited = exited;
    this.#config = config;
    this.#stop = stop;
    child.stdout!.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.on('error', () => this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE')));
    child.on('close', () => this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE')));
  }

  #rejectWaiters(error: LocalAiError): void {
    for (const [id, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(error);
      this.#waiters.delete(id);
    }
  }

  #onStdout(chunk: Buffer): void {
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.length > this.#config.maxLineBytes && this.#stdoutBuffer.indexOf(0x0a) < 0) {
      this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
      void this.close().catch(() => undefined);
      return;
    }
    let boundary = this.#stdoutBuffer.indexOf(0x0a);
    while (boundary >= 0) {
      const line = this.#stdoutBuffer.subarray(0, boundary);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(boundary + 1);
      if (line.length > this.#config.maxLineBytes) {
        this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
        void this.close().catch(() => undefined);
        return;
      }
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(line); }
      catch { this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE')); void this.close().catch(() => undefined); return; }
      this.#onLine(decoded);
      boundary = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  #onLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.#config.maxLineBytes) {
      this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
      void this.close().catch(() => undefined);
      return;
    }
    let reply: unknown;
    try { reply = JSON.parse(line); } catch {
      this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
      void this.close().catch(() => undefined);
      return;
    }
    if (!assertRecord(reply) || reply.jsonrpc !== '2.0' || typeof reply.id !== 'string') {
      this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
      void this.close().catch(() => undefined);
      return;
    }
    const waiter = this.#waiters.get(reply.id);
    if (!waiter) {
      if (this.#waiters.size) {
        this.#rejectWaiters(serviceError('ENGINE_UNAVAILABLE'));
        void this.close().catch(() => undefined);
      }
      return;
    }
    this.#waiters.delete(reply.id);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    if (assertRecord(reply.error)) {
      const privateData = assertRecord(reply.error.data) && assertRecord(reply.error.data.diagnostic) ? reply.error.data.diagnostic : undefined;
      const stage = privateData && ['audio_probe', 'audio_decode', 'short_transcribe', 'longform_upstream', 'longform_normalize'].includes(String(privateData.stage)) ? String(privateData.stage) : 'runner_reply';
      const error = reply.error.code === -32001 ? serviceError('INVALID_ARGUMENT', 'AUDIO_INVALID_OR_TOO_LARGE') : serviceError('ENGINE_UNAVAILABLE');
      diagnostic(waiter.method, stage, 'gigaam_pytorch', error.code, Date.now() - waiter.startedAt);
      waiter.reject(error);
    }
    else if (Object.hasOwn(reply, 'result')) waiter.resolve(reply.result);
    else waiter.reject(serviceError('ENGINE_UNAVAILABLE'));
  }

  async #rpc(method: string, params: Record<string, unknown>, context: OperationContext): Promise<unknown> {
    checkContext(context);
    if (!this.#child.stdin || this.#child.stdin.destroyed) throw serviceError('ENGINE_UNAVAILABLE');
    const id = String(++this.#nextId);
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.#config.maxLineBytes) throw serviceError('INPUT_TOO_LARGE');
    const reply = new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        const waiter = this.#waiters.get(id);
        if (!waiter) return;
        this.#waiters.delete(id);
        clearTimeout(waiter.timer);
        context.signal.removeEventListener('abort', abort);
        reject(serviceError(remainingCode(context)));
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        context.signal.removeEventListener('abort', abort);
        reject(serviceError(Date.parse(context.deadlineAt) <= Date.now() ? 'DEADLINE_EXCEEDED' : 'ENGINE_UNAVAILABLE'));
      }, this.#config.requestTimeoutMs);
      const waiter = { resolve, reject, timer, signal: context.signal, abort, method, startedAt: Date.now() };
      this.#waiters.set(id, waiter);
      context.signal.addEventListener('abort', abort, { once: true });
      const ok = this.#child.stdin!.write(line);
      if (!ok) this.#child.stdin!.once('drain', () => undefined);
    });
    return reply;
  }

  async health(context: OperationContext, selector: ResolvedModel['model']): Promise<void> {
    const result = await this.#rpc('health', {}, context);
    if (!assertRecord(result) || result.ready !== true
      || result.model_id !== selector.modelId || result.revision !== selector.revision
      || result.vad_revision !== this.#config.vadRevision) {
      throw serviceError('MODEL_LOAD_FAILED');
    }
  }

  async embed(_input: EmbedInput, _context: OperationContext): Promise<EmbedOutput> {
    throw serviceError('UNSUPPORTED_OPERATION');
  }

  async transcribe(input: TranscribeInput, context: OperationContext): Promise<TranscribeOutput> {
    const result = await this.#rpc('transcribe', { audio_path: input.audioPath }, context);
    if (!assertRecord(result) || typeof result.text !== 'string') throw serviceError('ENGINE_UNAVAILABLE');
    if (result.segments !== undefined && (!Array.isArray(result.segments) || !result.segments.every(segment =>
      assertRecord(segment) && typeof segment.start_seconds === 'number' && Number.isFinite(segment.start_seconds)
      && typeof segment.end_seconds === 'number' && Number.isFinite(segment.end_seconds) && segment.end_seconds >= segment.start_seconds && typeof segment.text === 'string'))) {
      throw serviceError('ENGINE_UNAVAILABLE');
    }
    return {
      text: result.text,
      ...(Array.isArray(result.segments) ? { segments: result.segments.map(segment => ({
        startSeconds: (segment as { start_seconds: number }).start_seconds,
        endSeconds: (segment as { end_seconds: number }).end_seconds,
        text: (segment as { text: string }).text,
      })) } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      await this.#stop();
      await this.exited;
    })();
    return this.#closePromise;
  }
}

async function readResponse(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw serviceError('ENGINE_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw serviceError('ENGINE_UNAVAILABLE'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function remainingCode(context: OperationContext): 'CANCELLED' | 'DEADLINE_EXCEEDED' {
  return Date.parse(context.deadlineAt) <= Date.now() ? 'DEADLINE_EXCEEDED' : 'CANCELLED';
}

class LlamaRuntime implements RuntimePort {
  readonly exited: Promise<void>;
  #child: ChildProcess;
  #config: ProfileRuntimeFactoryConfig['profiles']['llama_cpp'];
  #base: URL;
  #fetch: typeof fetch;
  #closePromise?: Promise<void>;
  #stop: () => Promise<void>;

  constructor(child: ChildProcess, exited: Promise<void>, config: ProfileRuntimeFactoryConfig['profiles']['llama_cpp'], port: number, fetcher: typeof fetch, stop: () => Promise<void>) {
    this.#child = child;
    this.exited = exited;
    this.#config = config;
    this.#base = new URL(`http://${config.host}:${port}`);
    this.#fetch = fetcher;
    this.#stop = stop;
  }

  async health(context: OperationContext, selector: ResolvedModel['model']): Promise<void> {
    const response = await this.#request('/health', undefined, context);
    if (!response.ok) throw serviceError('MODEL_LOAD_FAILED');
    await response.body?.cancel().catch(() => undefined);
    // The selected model and revision come from the verified local installation. The pinned server exposes readiness only.
    void selector;
  }

  async #request(path: string, init: RequestInit | undefined, context: OperationContext): Promise<Response> {
    checkContext(context);
    try {
      return await this.#fetch(new URL(path, this.#base), {
        ...init,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(this.#config.requestTimeoutMs)]),
      });
    } catch {
      if (context.signal.aborted || Date.parse(context.deadlineAt) <= Date.now()) throw serviceError(remainingCode(context));
      throw serviceError('ENGINE_UNAVAILABLE');
    }
  }

  async embed(input: EmbedInput, context: OperationContext): Promise<EmbedOutput> {
    const prepared = input.texts.map(text => input.purpose === 'query'
      ? `Instruct: ${this.#config.queryInstruction}\nQuery: ${text}` : text);
    let batchTokens = 0;
    for (const content of prepared) {
      const tokenResponse = await this.#request('/tokenize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, add_special: true }),
      }, context);
      if (!tokenResponse.ok) throw serviceError('ENGINE_UNAVAILABLE');
      let tokenBody: unknown;
      try { tokenBody = JSON.parse(await readResponse(tokenResponse, this.#config.maxLineBytes)); }
      catch { throw serviceError('ENGINE_UNAVAILABLE'); }
      if (!assertRecord(tokenBody) || !Array.isArray(tokenBody.tokens)
        || !tokenBody.tokens.every(token => Number.isSafeInteger(token))) throw serviceError('ENGINE_UNAVAILABLE');
      if (tokenBody.tokens.length > this.#config.contextTokens) throw serviceError('INPUT_TOO_LARGE');
      batchTokens += tokenBody.tokens.length;
      if (batchTokens > this.#config.maxBatchTokens) throw serviceError('INPUT_TOO_LARGE');
    }
    let response: Response;
    try {
      response = await this.#request('/v1/embeddings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: input.model.modelId, input: prepared }),
      }, context);
    } catch (error) {
      if (error instanceof LocalAiError && error.code === 'DEADLINE_EXCEEDED') throw error;
      if (error instanceof LocalAiError && error.code === 'CANCELLED') throw error;
      throw serviceError('ENGINE_UNAVAILABLE');
    }
    if (!response.ok) {
      const errorBody = await readResponse(response, Math.min(8192, this.#config.maxLineBytes)).catch(() => '');
      if (/too large to process/i.test(errorBody)) throw serviceError('INPUT_TOO_LARGE');
      throw serviceError('ENGINE_UNAVAILABLE');
    }
    let body: unknown;
    try { body = JSON.parse(await readResponse(response, this.#config.maxLineBytes)); } catch { throw serviceError('ENGINE_UNAVAILABLE'); }
    return assertVectors(body, input.texts.length, this.#config.dimensions);
  }

  async transcribe(_input: TranscribeInput, _context: OperationContext): Promise<TranscribeOutput> {
    throw serviceError('UNSUPPORTED_OPERATION');
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      await this.#stop();
      await this.exited;
    })();
    return this.#closePromise;
  }
}

/** Создаёт адаптеры только для закреплённых профилей и проверяет готовность до возврата runtime. */
export function createProfileRuntimeFactory(config: ProfileRuntimeFactoryConfig): RuntimeFactory {
  const fetcher = config.fetch ?? fetch;
  return {
    async open(model, context): Promise<RuntimePort> {
      if (model.model.profileId === 'llama_cpp') {
        const profile = config.profiles.llama_cpp;
        validateProfileConfig(profile);
        const gguf = model.installation.files.find(file => file.path.endsWith('.gguf'));
        if (!gguf || model.installation.modelId !== model.model.modelId || model.installation.revision !== model.model.revision) {
          throw serviceError('MODEL_NOT_INSTALLED');
        }
        const port = profile.port();
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw serviceError('MODEL_LOAD_FAILED');
        const args = substitute(profile.args, { modelPath: join(model.installation.directory, gguf.path), port: String(port) });
        const process = spawnRuntime(profile, args, { executor: 'llama_cpp' });
        const runtime = new LlamaRuntime(process.child, process.exited, profile, port, fetcher, process.stop);
        try {
          await waitUntilReady(runtime, process.exited, profile.startupTimeoutMs, context, model.model);
          return runtime;
        } catch (error) {
          try { await runtime.close(); }
          catch { await runtime.exited; }
          if (error instanceof LocalAiError) throw error;
          throw serviceError('MODEL_LOAD_FAILED');
        }
      }
      if (model.model.profileId === 'gigaam_pytorch') {
        const profile = config.profiles.gigaam_pytorch;
        validateProfileConfig(profile);
        const modelFile = model.installation.files.find(file => file.path === 'config.json');
        if (!modelFile || model.installation.modelId !== model.model.modelId || model.installation.revision !== model.model.revision
          || !Number.isSafeInteger(profile.threads) || profile.threads < 1 || !profile.vadRevision
          || !Number.isFinite(profile.audioDecodeTimeoutSeconds) || profile.audioDecodeTimeoutSeconds <= 0 || !Number.isFinite(profile.longformMaximumSeconds) || profile.longformMaximumSeconds <= 25) {
          throw serviceError('MODEL_NOT_INSTALLED');
        }
        const args = substitute(profile.args, {
          modelPath: model.installation.directory,
          vadModelPath: profile.vadModelPath,
          threads: String(profile.threads),
          longformMaximumSeconds: String(profile.longformMaximumSeconds),
          audioDecodeTimeoutSeconds: String(profile.audioDecodeTimeoutSeconds),
        });
        const privateTemp = await createGigaPrivateTempDirectory();
        let process: SpawnedRuntime;
        try {
          process = spawnRuntime(profile, args, {
            executor: 'gigaam_pytorch',
            privateTempDirectory: privateTemp.path,
            cleanupAfterGroupExit: () => removeGigaPrivateTempDirectory(privateTemp),
          });
        } catch (error) {
          await removeGigaPrivateTempDirectory(privateTemp);
          throw error;
        }
        const runtime = new ChildRuntime(process.child, process.exited, profile, process.stop);
        try {
          await waitUntilReady(runtime, process.exited, profile.startupTimeoutMs, context, model.model);
          return runtime;
        } catch (error) {
          try { await runtime.close(); }
          catch { await runtime.exited; }
          if (error instanceof LocalAiError) throw error;
          throw serviceError('MODEL_LOAD_FAILED');
        }
      }
      throw serviceError('NOT_SUPPORTED');
    },
  };
}

async function waitUntilReady(
  runtime: LlamaRuntime | ChildRuntime,
  exited: Promise<void>,
  timeoutMs: number,
  context: OperationContext,
  selector: ResolvedModel['model'],
): Promise<void> {
  const deadline = Math.min(Date.now() + timeoutMs, Date.parse(context.deadlineAt));
  const startup = new AbortController();
  const timer = setTimeout(() => startup.abort(), Math.max(1, deadline - Date.now()));
  timer.unref();
  const healthContext = { ...context, deadlineAt: new Date(deadline).toISOString(), signal: AbortSignal.any([context.signal, startup.signal]) };
  try {
    while (Date.now() < deadline) {
      checkContext(context);
      const result = await Promise.race([
        runtime.health(healthContext, selector).then(() => true).catch(() => false),
        exited.then(() => { throw serviceError('MODEL_LOAD_FAILED'); }),
      ]);
      checkContext(context);
      if (Date.now() >= deadline) break;
      if (result) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
    throw serviceError(Date.parse(context.deadlineAt) <= Date.now() ? 'DEADLINE_EXCEEDED' : 'MODEL_LOAD_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
