// ABOUTME: Передаёт файл выбранного пользователя из доверенного Artifacts в браузер потоком.
// ABOUTME: Использует проверенный descriptor и передаёт источнику только нормализованный диапазон.
import { createHash } from "node:crypto";
import { GatewayError } from "./gateway";
type Descriptor = { artifactId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string };
/** Ограничивает выдачу опубликованным файлом и сверяет SHA-256 при полном чтении. */
export async function adminDownload(value: unknown, artifactId: unknown, signal: AbortSignal, preview = false, rangeHeader: string | null = null, ifRange: string | null = null): Promise<Response> {
 const file = value as Partial<Descriptor> | null;
 if (!file || typeof artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId) || file.artifactId !== artifactId || typeof file.filename !== "string" || typeof file.mimeType !== "string" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes! < 0 || file.sizeBytes! > 2 * 1024 ** 3 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new GatewayError(502, "BAD_REPLY");
 const mime = file.mimeType.toLowerCase().split(";", 1)[0].trim();
 const inline = preview && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/webm", "audio/wav", "audio/x-wav", "audio/flac", "video/mp4", "video/webm", "video/ogg"].includes(mime);
 const etag = `"${file.sha256}"`;
 let range: { start: number; end: number } | null = null;
 if (rangeHeader && (ifRange === null || ifRange === etag)) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const size = file.sizeBytes!;
  const first = match?.[1] ? Number(match[1]) : null, last = match?.[2] ? Number(match[2]) : null;
  const start = first ?? Math.max(0, size - (last ?? 0)), end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (!match || first === null && !last || first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last) || start >= size || start > end) {
   return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes", "ETag": etag, "Cache-Control": "no-store" } });
  }
  range = { start, end };
 }
 let base: URL;
 try { base = new URL(process.env.WEB_ADMIN_ARTIFACTS_BASE_URL ?? ""); } catch { throw new GatewayError(503, "ARTIFACTS_NOT_CONFIGURED"); }
 if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new GatewayError(503, "ARTIFACTS_NOT_CONFIGURED");
 const byteCount = range ? range.end - range.start + 1 : file.sizeBytes!;
 const contentRange = range ? `bytes ${range.start}-${range.end}/${file.sizeBytes}` : null;
 // Докачка должна пройти ту же проверку SHA-256, что и выдача целого файла.
 const sourceRange = inline ? range : null;
 const sourceBytes = sourceRange ? byteCount : file.sizeBytes!;
 const start = sourceRange ? 0 : range?.start ?? 0;
 const end = start + byteCount;
 const headers = { "Accept-Encoding": "identity", ...(sourceRange ? { Range: `bytes=${sourceRange.start}-${sourceRange.end}` } : {}) };
 const upstream = await fetch(new URL(`/files/${artifactId}`, base), { redirect: "error", signal, cache: "no-store", headers });
 if (upstream.status !== (sourceRange ? 206 : 200) || !upstream.body ||
     upstream.headers.get("content-range") !== (sourceRange ? contentRange : null) ||
     (upstream.headers.get("content-encoding") ?? "identity") !== "identity" ||
     (upstream.headers.get("content-length") ?? String(sourceBytes)) !== String(sourceBytes)) {
  await upstream.body?.cancel().catch(() => {});
  throw new GatewayError(503, "ARTIFACT_UNAVAILABLE");
 }
 const reader = upstream.body.getReader();
 // Перемотка предпросмотра опирается на проверку при публикации неизменяемого файла Artifacts.
 const hash = sourceBytes === file.sizeBytes ? createHash("sha256") : null;
 let size = 0, finished = false;
 let finalChunk: Uint8Array | null = null;
 const body = new ReadableStream<Uint8Array>({
  async pull(controller) {
   try {
    while (true) {
     const part = await reader.read();
     if (part.done) {
      finished = true;
      if (size !== sourceBytes || (hash && hash.digest("hex") !== file.sha256)) throw new Error("ARTIFACT_INTEGRITY");
      if (finalChunk) controller.enqueue(finalChunk);
      controller.close(); reader.releaseLock(); return;
     }
     const chunk = part.value;
     const offset = size;
     size += chunk.byteLength;
     if (size > sourceBytes) throw new Error("ARTIFACT_SIZE");
     hash?.update(chunk);
     const selected = chunk.subarray(Math.max(0, start - offset), Math.max(0, end - offset));
     if (selected.byteLength) {
      // Последние байты удерживаем до сверки: Content-Length не должен позволить
      // браузеру завершить ответ раньше проверки размера и, при полном чтении, SHA-256.
      if (size >= end) { finalChunk = selected; continue; }
      controller.enqueue(selected); return;
     }
    }
   } catch (error) { if (!finished) await reader.cancel().catch(() => {}); reader.releaseLock(); controller.error(error); }
  },
  async cancel() { await reader.cancel().catch(() => {}); },
 });
 const name = file.filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180).toWellFormed() || "download";
 const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
 return new Response(body, { status: range ? 206 : 200, headers: { "Content-Length": String(byteCount), "Accept-Ranges": "bytes", "ETag": etag, ...(contentRange ? { "Content-Range": contentRange } : {}), "Content-Type": inline ? mime : "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${encoded}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
}
