// ABOUTME: Проверяет входы по опубликованным JSON Schema Draft-07.
// ABOUTME: Не выполняет прикладные переходы и не исправляет входные данные.
import { readFileSync } from "node:fs";
import AjvImport, { type ValidateFunction } from "ajv";
import formatsImport from "ajv-formats";
import type { Command, EventKind } from "./domain.js";
/** Отображает смысл события на публичный транспортный адрес. */
export function eventSubject(kind: EventKind): string { return "brai.timer.v1.event." + kind; }
/** Отображает проверенный транспортный адрес на операцию ядра. */
export function commandType(subject: string): "start" | "stop" {
 if (subject === "brai.timer.v1.command.start") return "start";
 if (subject === "brai.timer.v1.command.stop") return "stop";
 throw new Error("INVALID_ARGUMENT");
}
const Ajv = AjvImport as unknown as typeof AjvImport.default;
const addFormats = formatsImport as unknown as typeof formatsImport.default;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const name of ["common", "commands", "messages"]) ajv.addSchema(JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")));
const commandBase="https://brai.invalid/contracts/timer/v1/commands.schema.json#/definitions/";
const messageBase="https://brai.invalid/contracts/timer/v1/messages.schema.json#/definitions/";
const start=ajv.compile({$ref:commandBase+"StartCommand"});
const stop=ajv.compile({$ref:commandBase+"StopCommand"});
const queries: Record<string,ValidateFunction> = Object.fromEntries(["SnapshotRequest", "HistoryRequest", "CommandLookupRequest"].map(name=>[name,ajv.compile({$ref:messageBase+name})]));
/** Извлекает идентичность полного JSON до schema validation для конфликтов уже принятого ID. */
export function identity(data: Uint8Array): {commandId: string | null;content: string | null} {
 try {
  const input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data));
  const id=input && typeof input === "object" && !Array.isArray(input) ? input.commandId : null;
  return {commandId:typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:null,content:canonical(input)};
 } catch{return {commandId:null,content:null};}
}
/** Возвращает команду только при соответствии subject и его схеме. */
export function parseCommand(subject: string, data: Uint8Array): Command | null {
  try {
    const input=JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(data));
    const validate=subject === "brai.timer.v1.command.start" ? start : subject === "brai.timer.v1.command.stop" ? stop : undefined;
    return validate?.(input) ? input as Command : null;
  } catch { return null; }
}
/** Проверяет тело endpoint; выбрасывает INVALID_ARGUMENT без включения исходных данных. */
export function parseQuery(name: string, data: Uint8Array): Record<string,unknown> {
  try {
    const input=JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(data));
    if (queries[name]?.(input)) return input as Record<string,unknown>;
  } catch { /* Ошибка JSON становится той же контрактной ошибкой. */ }
  throw new Error("INVALID_ARGUMENT");
}
/** Канонизирует весь JSON: порядок ключей не влияет на идентичность команды. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "["+value.map(canonical).join(",")+"]";
  if (value !== null && typeof value === "object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical((value as Record<string,unknown>)[k])).join(",")+"}";
  return JSON.stringify(value);
}
