// ABOUTME: Подставляет имена в исторические ссылки до очистки служебных ID.
// ABOUTME: Меняет только представление, сохраняя канонические данные.
import type { BoardData } from "./model";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SHORT_ID_PATTERN = /\b(?:V?[GT]\d+(?:-[MF]?\d+)?|M\d+|R\d+)\b/gi;
export function readable(value: string | undefined | null) {
 return (value ?? "").replace(UUID_PATTERN, "").replace(SHORT_ID_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}
export function resourceText(value: string) {
 try {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null) return "";
  if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  if (parsed && typeof parsed === "object") {
   const parts: string[] = [];
   const collect = (item: unknown) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") parts.push(String(item));
    else if (Array.isArray(item)) item.forEach(collect);
    else if (item && typeof item === "object") Object.values(item).forEach(collect);
   };
   collect(parsed);
   return parts.join("\n");
  }
 } catch { /* Обычный текст показываем без преобразования. */ }
 return value;
}
export function conditionText(value: unknown) {
 if (typeof value === "string") return value;
 if (!value || typeof value !== "object") return "";
 const prerequisite = (value as { prerequisite?: unknown }).prerequisite;
 return typeof prerequisite === "string" ? prerequisite : "";
}
function requiredResourceIds(value: unknown) {
 if (!value || typeof value !== "object" || Array.isArray(value)) return [];
 const ids = (value as { required_resources?: unknown }).required_resources;
 return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string"))] : [];
}
/** Подставляет имена в старые текстовые ссылки, не меняя канонические записи. */
export function presentBoard(source: BoardData): BoardData {
 const names = new Map<string, string>();
 const alias = (value: unknown) => value && typeof value === "object" && typeof (value as { source_alias?: unknown }).source_alias === "string" ? (value as { source_alias: string }).source_alias : "";
 for (const element of source.elements) {
  const revisionAlias = alias(element.fields);
  const elementAlias = revisionAlias.replace(/^V/, "").replace(/-\d+$/, "");
  if (elementAlias) names.set(elementAlias, element.title);
  if (revisionAlias) names.set(revisionAlias, `постановка «${element.title}»`);
 }
 for (const move of source.moves) if (alias(move.fields)) names.set(alias(move.fields), move.title);
 for (const resource of source.resources) if (alias(resource.metadata)) names.set(alias(resource.metadata), resource.title);
 const text = (value: string) => {
  // Два прохода раскрывают название ресурса, которое само ссылается на Элемент.
  for (let i = 0; i < 2; i++) value = value.replace(/\b(?:V?[GT]\d+(?:-[MF]?\d+)?|R\d+|S[12])\b/g, token => token === "S1" ? "первый сервис" : token === "S2" ? "второй сервис" : names.get(token) ?? "");
  return readable(value);
 };
 return { ...source,
  elements: source.elements.map(item => ({ ...item, title: text(item.title), description: text(item.description), instructions: text(item.instructions ?? "") })),
  moves: source.moves.map(item => ({ ...item, requiredResourceIds: item.requiredResourceIds ?? requiredResourceIds(item.conditions), title: text(item.title), instructions: text(item.instructions ?? ""), conditions: text(conditionText(item.conditions)) })),
  resources: source.resources.map(item => ({ ...item, title: text(item.title), content: resourceText(item.content).split("\n").map(text).join("\n") })) };
}
