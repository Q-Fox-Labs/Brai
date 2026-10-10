// ABOUTME: Передаёт байты publisher через ограниченные HTTP потоки Node.js.
// ABOUTME: Срок задаёт AbortSignal вызывающего; скрытый timeout ожидания HTTP headers отсутствует.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Выполняет GET/PUT без redirect и буферизации файла, поддерживает явную отмену потока. */
export const publisherFetch: typeof fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVALID_ARTIFACT_URL');
  const headers = Object.fromEntries(new Headers(options.headers).entries()), signal = options.signal ?? undefined;
  signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    // AIDEV-NOTE: Undici fetch ограничивает headers ожидание 5 минутами, включая активный PUT.
    // Здесь единственный срок — signal; отдельный агент не наследует таймеры общего HTTP pool.
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: options.method ?? 'GET', headers, signal, agent: false });
    request.once('error', reject);
    request.once('response', response => {
      const status = response.statusCode ?? 500;
      if (status >= 300 && status < 400) { response.destroy(); reject(new Error('HTTP_REDIRECT')); return; }
      const responseHeaders = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      const abort = () => response.destroy(signal?.reason instanceof Error ? signal.reason : new Error('CANCELLED'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      response.once('close', () => signal?.removeEventListener('abort', abort));
      // AIDEV-NOTE: Web queue измеряет байты, иначе Node highWaterMark стал бы числом chunks.
      const body = Readable.toWeb(response, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } });
      try { resolve(new Response([204, 205, 304].includes(status) ? null : body as ReadableStream<Uint8Array>, { status, headers: responseHeaders })); }
      catch (error) { response.destroy(); reject(error); }
    });
    if (options.body) {
      if (!(options.body instanceof Readable)) { request.destroy(); reject(new Error('INVALID_STREAM_BODY')); return; }
      void pipeline(options.body, request, { signal }).catch(error => { request.destroy(error); reject(error); });
    } else request.end();
  });
};
