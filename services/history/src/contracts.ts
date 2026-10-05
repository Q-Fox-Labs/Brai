// ABOUTME: Проверяет DTO по схемам-владельцам сервиса истории.
// ABOUTME: Не нормализует и не переписывает входные данные.
import { readFileSync } from "node:fs";
import AjvImport, { type ValidateFunction } from "ajv";
import formatsImport from "ajv-formats";

/** Одно неизменяемое событие со всеми одиннадцатью сохранёнными полями. */
export interface HistoryEvent {
  id: string;
  source: string;
  type_id: number;
  occurred_at: string;
  recorded_at: string;
  actor_id: string | null;
  scope_type: string;
  scope_id: string;
  object_type: string | null;
  object_id: string | null;
  data: Record<string, unknown>;
}
/** Безопасное тело ошибки, возвращаемое при неуспешной операции. */
export interface HistoryError { code: string; message: string; retryable: boolean }
export const limits = {
  maxRequestBytes: 65_536,
  maxResponseBytes: 524_288,
  deadlineMs: 10_000,
  active: 8,
  queue: 64,
  defaultPageSize: 50,
  maxPageSize: 100,
  maxEventBytes: 65_536
} as const;
export const errorStatus = {
  INVALID_ARGUMENT: 400,
  INVALID_CURSOR: 400,
  NOT_FOUND: 404,
  EVENT_ID_CONFLICT: 409,
  REQUEST_TOO_LARGE: 413,
  RESULT_TOO_LARGE: 413,
  BUSY: 503,
  DATABASE_UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
  INTERNAL: 500
} as const;
export type HistoryErrorCode = keyof typeof errorStatus;
export type ToolName =
  | "history_categories_list" | "history_types_list" | "history_type_get"
  | "history_append" | "history_get" | "history_search"
  | "history_category_create" | "history_category_update"
  | "history_type_create" | "history_type_update";

const Ajv = AjvImport as unknown as typeof AjvImport.default;
const addFormats = formatsImport as unknown as typeof formatsImport.default;
const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false });
for (const name of ["common", "messages", "tools"]) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"));
  if (name === "common") addFormats(ajv);
  ajv.addSchema(schema);
}
const messageId = "https://brai.invalid/contracts/history/v1/messages.schema.json#/definitions/";
const toolId = "https://brai.invalid/contracts/history/v1/tools.schema.json#/definitions/";
const natsValidators: Record<string, ValidateFunction> = {
  append: ajv.compile({ $ref: messageId + "appendRequest" }),
  list: ajv.compile({ $ref: messageId + "listRequest" }),
  get: ajv.compile({ $ref: messageId + "getRequest" })
};
export const toolInputDefinitions: Record<ToolName, string> = {
  history_categories_list: "categoriesListRequest",
  history_types_list: "typesListRequest",
  history_type_get: "typeGetRequest",
  history_append: "appendRequest",
  history_get: "getRequest",
  history_search: "searchRequest",
  history_category_create: "categoryCreateRequest",
  history_category_update: "categoryUpdateRequest",
  history_type_create: "typeCreateRequest",
  history_type_update: "typeUpdateRequest"
};
export const toolOutputDefinitions: Record<ToolName, string> = {
  history_categories_list: "categoriesListResponse",
  history_types_list: "typesListResponse",
  history_type_get: "typeGetResponse",
  history_append: "appendResponse",
  history_get: "getResponse",
  history_search: "searchResponse",
  history_category_create: "mutationResponse",
  history_category_update: "mutationResponse",
  history_type_create: "mutationResponse",
  history_type_update: "mutationResponse"
};
const toolValidators = Object.fromEntries(Object.entries(toolInputDefinitions).map(([name, definition]) =>
  [name, ajv.compile({ $ref: toolId + definition })])) as Record<ToolName, ValidateFunction>;
const toolOutputValidators = Object.fromEntries(Object.entries(toolOutputDefinitions).map(([name, definition]) =>
  [name, ajv.compile({ $ref: toolId + definition })])) as Record<ToolName, ValidateFunction>;
const natsResponseValidators: Record<string, ValidateFunction> = {
  append: ajv.compile({ $ref: messageId + "appendResponse" }),
  list: ajv.compile({ $ref: messageId + "listResponse" }),
  get: ajv.compile({ $ref: messageId + "getResponse" }),
  error: ajv.compile({ $ref: messageId + "serviceError" })
};

/** Читает UTF-8 JSON с отказом на неверной кодировке и синтаксисе. */
export function decodeJson(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}
/** Проверяет тело NATS endpoint по его owner schema. */
export function validateNatsRequest(name: "append" | "list" | "get", value: unknown): boolean {
  return natsValidators[name](value);
}
/** Проверяет вход MCP-инструмента по его owner schema. */
export function validateToolInput(name: ToolName, value: unknown): boolean {
  return toolValidators[name](value);
}
/** Проверяет результат MCP-инструмента по схеме-владельцу. */
export function validateToolOutput(name: ToolName, value: unknown): boolean {
  return toolOutputValidators[name](value);
}
/** Проверяет успешный ответ или ошибку NATS endpoint по схеме-владельцу. */
export function validateNatsResponse(name: "append" | "list" | "get" | "error", value: unknown): boolean {
  return natsResponseValidators[name](value);
}
/** Возвращает Ajv validation errors для безопасной диагностической обработки. */
export function validationErrors(name: ToolName | "append" | "list" | "get"): string[] {
  const validator = name in toolValidators
    ? toolValidators[name as ToolName]
    : natsValidators[name as "append" | "list" | "get"];
  return (validator.errors ?? []).map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}

/** Возвращает ошибки проверки результата MCP без включения исходных данных. */
export function outputValidationErrors(name: ToolName): string[] {
  return (toolOutputValidators[name].errors ?? []).map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}
