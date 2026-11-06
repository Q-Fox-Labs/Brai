// ABOUTME: Передаёт файл выбранного пользователя из доверенного Artifacts в браузер потоком.
// ABOUTME: Принимает только проверенный bridge descriptor; адрес и заголовки клиента не передаются upstream.
import { createHash } from "node:crypto";
import { GatewayError } from "./gateway";
type Descriptor = { artifactId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string };
/** Проверяет descriptor и ограничивает поток размером и контрольной суммой владельца. */
export async function adminDownload(value: unknown, artifactId: unknown, signal: AbortSignal): Promise<Response> {
 const file = value as Partial<Descriptor> | null;
 if (!file || typeof artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artifactId) || file.artifactId !== artifactId || typeof file.filename !== "string" || typeof file.mimeType !== "string" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes! < 0 || file.sizeBytes! > 2 * 1024 ** 3 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new GatewayError(502, "BAD_REPLY");
 let base: URL;
 try { base = new URL(process.env.WEB_ADMIN_ARTIFACTS_BASE_URL ?? ""); } catch { throw new GatewayError(503, "ARTIFACTS_NOT_CONFIGURED"); }
 if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new GatewayError(503, "ARTIFACTS_NOT_CONFIGURED");
 const upstream = await fetch(new URL(`/files/${artifactId}`, base), { redirect: "error", signal, cache: "no-store", headers: { "Accept-Encoding": "identity" } });
 if (upstream.status !== 200 || !upstream.body || (upstream.headers.has("content-length") && upstream.headers.get("content-length") !== String(file.sizeBytes))) { await upstream.body?.cancel().catch(() => {}); throw new GatewayError(503, "ARTIFACT_UNAVAILABLE"); }
 const reader = upstream.body.getReader(), hash = createHash("sha256");
 let size = 0, finished = false;
 const body = new ReadableStream<Uint8Array>({
  async pull(controller) {
   try {
    const part = await reader.read();
    if (part.done) {
     finished = true;
     if (size !== file.sizeBytes || hash.digest("hex") !== file.sha256) throw new Error("ARTIFACT_INTEGRITY");
     controller.close(); reader.releaseLock(); return;
    }
    size += part.value.byteLength;
    if (size > file.sizeBytes!) throw new Error("ARTIFACT_SIZE");
    hash.update(part.value); controller.enqueue(part.value);
   } catch (error) { if (!finished) await reader.cancel().catch(() => {}); reader.releaseLock(); controller.error(error); }
  },
  async cancel() { await reader.cancel().catch(() => {}); },
 });
 const name = file.filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180).toWellFormed() || "download";
 const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
 return new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
}
