// ABOUTME: Читает небольшие JSON тела с пределом размера и временем.
// ABOUTME: При превышении лимита, отмене или таймауте поток останавливается и освобождается.
export class RequestBodyFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

/** Читает ограниченное UTF-8 JSON тело, отменяя и освобождая поток на любом исходе. */
export async function readBoundedJson(request: Request, cap: number, timeoutMs: number): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > cap) {
    await request.body?.cancel().catch(() => {});
    throw new RequestBodyFailure(413, "REQUEST_TOO_LARGE");
  }
  if (!request.body) throw new RequestBodyFailure(400, "INVALID_ARGUMENT");
  if (request.signal.aborted) { await request.body.cancel().catch(() => {}); throw new RequestBodyFailure(408, "REQUEST_TIMEOUT"); }
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined, aborted = false;
  const cancel = () => { aborted = true; void reader.cancel(); };
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const read = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > cap) { await reader.cancel(); throw new RequestBodyFailure(413, "REQUEST_TOO_LARGE"); }
      chunks.push(part.value);
    }
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel(); reject(new RequestBodyFailure(408, "REQUEST_TIMEOUT")); }, timeoutMs);
  });
  let rejectAbort!: (reason: RequestBodyFailure) => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abortWithError = () => { cancel(); rejectAbort(new RequestBodyFailure(408, "REQUEST_TIMEOUT")); };
  request.signal.addEventListener("abort", abortWithError, { once: true });
  if (request.signal.aborted) abortWithError();
  try { await Promise.race([read, deadline, abort]); }
  catch (error) {
    if (error instanceof RequestBodyFailure) throw error;
    if (aborted) throw new RequestBodyFailure(408, "REQUEST_TIMEOUT");
    throw new RequestBodyFailure(400, "INVALID_ARGUMENT");
  }
  finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", abortWithError);
    try { reader.releaseLock(); } catch { /* Поток мог уже закрыться или быть отменён. */ }
  }
  if (aborted) throw new RequestBodyFailure(408, "REQUEST_TIMEOUT");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestBodyFailure(400, "INVALID_ARGUMENT"); }
}
