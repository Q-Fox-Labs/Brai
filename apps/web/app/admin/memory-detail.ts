// ABOUTME: Собирает проверенные части полной записи памяти администратора.
// ABOUTME: Не показывает частичную запись и не исполняет её содержимое.
type FetchChunk = (cursor?: string) => Promise<unknown>;
const MAX_BYTES = 16 * 1024 * 1024, CHUNK_BYTES = 450000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Проверяет цель, порядок, размер и SHA-256 до возврата полного JSON. */
export async function loadMemoryDetail(userId: string, memoryId: string, fetchChunk: FetchChunk): Promise<Record<string, unknown>> {
 let cursor: string | undefined, snapshot = "", hash = "", offset = 0, total = 0;
 let buffer: Uint8Array<ArrayBuffer> | undefined;
 const cursors = new Set<string>();
 for (let count = 0; count < 40; count++) {
  const value = await fetchChunk(cursor);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректная запись памяти.");
  const part = value as Record<string, unknown>;
  if (Object.keys(part).sort().join(",") !== "chunkBase64,memoryId,nextCursor,offset,sha256,snapshotId,totalBytes,userId" ||
      part.userId !== userId || part.memoryId !== memoryId || typeof part.snapshotId !== "string" || !uuid.test(part.snapshotId) ||
      !Number.isSafeInteger(part.offset) || part.offset !== offset || !Number.isSafeInteger(part.totalBytes) ||
      (part.totalBytes as number) < 1 || (part.totalBytes as number) > MAX_BYTES ||
      typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256) ||
      typeof part.chunkBase64 !== "string" || part.chunkBase64.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !base64.test(part.chunkBase64) ||
      !(part.nextCursor === null || typeof part.nextCursor === "string" && part.nextCursor.length > 0 && part.nextCursor.length <= 4096)) throw new Error("Некорректная запись памяти.");
  if (!buffer) {
   snapshot = part.snapshotId; hash = part.sha256; total = part.totalBytes as number;
   buffer = new Uint8Array(total);
  } else if (snapshot !== part.snapshotId || hash !== part.sha256 || total !== part.totalBytes) throw new Error("Запись памяти изменилась при чтении.");
  let binary: string;
  try { binary = atob(part.chunkBase64); } catch { throw new Error("Некорректная часть памяти."); }
  if (btoa(binary) !== part.chunkBase64 || !binary.length || binary.length > CHUNK_BYTES ||
      offset + binary.length > total || (part.nextCursor !== null && binary.length !== CHUNK_BYTES)) throw new Error("Некорректная часть памяти.");
  for (let i = 0; i < binary.length; i++) buffer[offset + i] = binary.charCodeAt(i);
  offset += binary.length;
  if (part.nextCursor === null) {
   if (offset !== total) throw new Error("Запись памяти получена не полностью.");
   const digest = await crypto.subtle.digest("SHA-256", buffer);
   if (Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("") !== hash) throw new Error("Контрольная сумма памяти не совпала.");
   let result: unknown;
   try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); } catch { throw new Error("Некорректная запись памяти."); }
   if (!result || typeof result !== "object" || Array.isArray(result) || (result as Record<string, unknown>).id !== memoryId) throw new Error("Некорректная запись памяти.");
   return result as Record<string, unknown>;
  }
  if (offset >= total || cursors.has(part.nextCursor as string)) throw new Error("Некорректный курсор памяти.");
  cursor = part.nextCursor as string; cursors.add(cursor);
 }
 throw new Error("Запись памяти получена не полностью.");
}
