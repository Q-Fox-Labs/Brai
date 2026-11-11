// ABOUTME: Строит локальные и модельные текстовые проекции наблюдения.
 // ABOUTME: Не отправляет данные и не считает модельный текст доверенным.
import { createHash } from "node:crypto";
import type { Observation } from "./contracts.js";

export const EMBEDDING_MODEL = { modelId: "embeddinggemma-2-q8", revision: "bfcd298762cc34d0357ece5ebdd31791a3a374d8", profileId: "embeddinggemma2_llama_cpp" } as const;
export const PROJECTION_VERSION = "1";
export const GENERATION = "gemma2-symmetric-v1";

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const searchFields = ["title", "operation", "expected", "observed", "steps", "diagnostic_text", "component_id", "component_version", "commit_sha", "deployment_revision", "error_code"] as const;
const exactFields = ["component_id", "component_version", "commit_sha", "deployment_revision", "operation", "error_code", "expected", "observed", "steps", "diagnostic_text"] as const;
const modelFields = ["title", "component_id", "operation", "component_version", "commit_sha", "deployment_revision", "expected", "observed", "error_code"] as const;

/** Формирует полный текст локального поиска без удаления чисел и отрицаний. */
export function searchProjection(observation: Observation): string {
 return searchFields.flatMap(field => {
  const value = observation[field];
  return typeof value === "string" ? [field + ": " + normalize(value)] : [];
 }).join("\n");
}

/** Строит scoped сигнатуру; для совпадения требуется сравнить также canonical. */
export function exactSignature(installationId: string, ownerId: string, observation: Observation): { hash: string; canonical: string } | null {
 if (!observation.component_id?.trim() || observation.component_id.trim().toLowerCase() === "unknown" ||
  ![observation.component_version, observation.commit_sha, observation.deployment_revision].some(value => typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "unknown")) return null;
 const values: Record<string, string | null | string[]> = {};
 for (const field of exactFields) {
  const value = observation[field];
  if (value !== undefined) values[field] = typeof value === "string" ? normalize(value) : value;
 }
 values.evidence_artifact_ids = observation.evidence_artifact_ids ?? [];
 const canonical = JSON.stringify({ installationId, ownerId, values });
 return { hash: digest(canonical), canonical };
}

/** Готовит минимальную непроверенную проекцию; явный секрет или URL блокирует её целиком. */
export function modelProjection(observation: Observation): { text: string; hash: string; excluded_fields: string[]; policy_version: string; blocked: boolean } {
 const excluded_fields = Object.keys(observation).filter(field => !(modelFields as readonly string[]).includes(field)).sort();
 const text = modelFields.flatMap(field => {
  const value = observation[field];
  return typeof value === "string" ? [field + ": " + normalize(value)] : [];
 }).join("\n");
 // AIDEV-NOTE: Проверка блокирует обнаруженные признаки, но не гарантирует отсутствие личных данных.
 const blocked = /(?:\b(?:https?|ftp):\/\/|\bwww\.|\b(?:bearer|basic)\s+\S+|\b(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+|-----BEGIN [^-]*PRIVATE KEY-----)/iu.test(text);
 const safeText = blocked ? "" : text;
 return { text: safeText, hash: digest(safeText), excluded_fields, policy_version: PROJECTION_VERSION, blocked };
}

/** Делит текст по UTF-16 offsets, не разрезая пары surrogate; покрытие явно учитывает пределы. */
export function chunkText(text: string): { chunks: { index: number; start: number; end: number; text: string; hash: string }[]; coverage: "complete" | "partial"; total_chars: number; covered_chars: number } {
 const chunks: { index: number; start: number; end: number; text: string; hash: string }[] = [];
 let start = 0, end = 0, chunkBytes = 0, sourceBytes = 0;
 while (end < text.length && chunks.length < 64) {
  const codePoint = text.codePointAt(end)!;
  const width = codePoint > 0xffff ? 2 : 1;
  const bytes = Buffer.byteLength(text.slice(end, end + width), "utf8");
  if (sourceBytes + bytes > 65536) break;
  if (chunkBytes + bytes > 1200) {
   const part = text.slice(start, end);
   chunks.push({ index: chunks.length, start, end, text: part, hash: digest(part) });
   start = end;
   chunkBytes = 0;
   continue;
  }
  end += width;
  chunkBytes += bytes;
  sourceBytes += bytes;
 }
 if (end > start && chunks.length < 64) {
  const part = text.slice(start, end);
  chunks.push({ index: chunks.length, start, end, text: part, hash: digest(part) });
 }
 return { chunks, coverage: end === text.length ? "complete" : "partial", total_chars: text.length, covered_chars: end };
}

/** Принимает только конечный нормированный 768-мерный вектор; иначе выдаёт безопасную ошибку. */
export function validateEmbedding(value: unknown): asserts value is number[] {
 if (!Array.isArray(value) || value.length !== 768 || !value.every(x => typeof x === "number" && Number.isFinite(x))) throw new Error("INVALID_EMBEDDING");
 const norm = Math.hypot(...value);
 if (!Number.isFinite(norm) || norm === 0 || Math.abs(norm - 1) > 0.001) throw new Error("INVALID_EMBEDDING");
}
