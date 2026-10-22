// ABOUTME: Ограничивает и канонизирует JSON границы providers.
// ABOUTME: Не зависит от lifecycle, transport и модели.
export const JSON_DEPTH=32;
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
/** Канонические JSON bytes: порядок object keys не влияет, порядок arrays сохраняется. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(",")}}`;
}
/** Ограничивает весь JSON до рекурсивной валидации и хеширования. */
export function boundedJson(value: unknown, depth=0): boolean {
  if (depth > JSON_DEPTH) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !value.includes("\u0000") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  return Object.keys(value).every(k=>!k.includes("\u0000")) && Object.values(value).every(v=>boundedJson(v,depth+1));
}
