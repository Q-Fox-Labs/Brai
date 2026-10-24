// ABOUTME: Выполняет прикладные операции истории и проверяет безопасные повторы.
// ABOUTME: Не зависит от PostgreSQL, NATS или MCP; транзакции переданы явным портом.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { limits, validateToolInput, validateNatsRequest, type HistoryEvent, type HistoryErrorCode, type ToolName } from "./contracts.js";

/** Срок задаётся по performance.now(); бюджет относится ко всему JSON-ответу. */
export interface OperationContext { deadlineAt: number; signal: AbortSignal; responseBudgetBytes?: number }
/** Безопасная ошибка прикладного контракта без SQL или входных данных. */
export class HistoryFault extends Error {
  readonly retryable: boolean;
  constructor(readonly code: HistoryErrorCode) {
    super(code); this.name = "HistoryFault";
    this.retryable = ["BUSY", "DATABASE_UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(code);
  }
}
export interface Category { id: number; code: string; name: string; description: string }
export interface EventType extends Category { category_id: number }
export type CatalogRow = Category | EventType;
export type CatalogTable = "sys_categories" | "sys_types";
export type EventInput = Omit<HistoryEvent, "recorded_at">;
export type Filters = Partial<Pick<EventInput, "source" | "type_id" | "actor_id" | "object_type" | "object_id" | "scope_type" | "scope_id">> & { category_id?: number; occurred_from?: string; occurred_to?: string };
export type EventKey = [string, string, string];
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface MutationResult { result: CatalogRow; audit_event: HistoryEvent }
export type MutationOperation = "history_category_create" | "history_category_update" | "history_type_create" | "history_type_update";
export type MutationRequest = { event_id: string; actor_id: string | null; name: string; description: string; id?: number; code?: string; category_id?: number };
/** Нужные ядру операции одной транзакции; выход за callback запрещён. */
export interface HistoryTransaction {
  lockEvent(source: string, id: string): Promise<void>;
  event(source: string, id: string): Promise<HistoryEvent | null>;
  insertEvent(input: EventInput): Promise<HistoryEvent | null>;
  events(filters: Filters, after: EventKey | null, count: number): Promise<HistoryEvent[]>;
  catalog(table: CatalogTable, id: number, lock?: boolean): Promise<CatalogRow | null>;
  typeByCode(categoryCode: string, typeCode: string): Promise<EventType | null>;
  catalogList(table: CatalogTable, categoryId: number | undefined, after: number | null, count: number): Promise<CatalogRow[]>;
  catalogInsert(table: CatalogTable, request: MutationRequest): Promise<CatalogRow>;
  catalogUpdate(table: CatalogTable, request: MutationRequest): Promise<CatalogRow>;
}
/** Порт хранения завершает commit/rollback и освобождение соединения до resolve/reject. */
export interface HistoryStore {
  transaction<T>(userId: string | null, context: OperationContext | undefined, run: (tx: HistoryTransaction) => Promise<T>): Promise<T>;
  ready(): Promise<void>;
}
/** Одна прикладная граница для двух транспортов; gate подключается вне ядра. */
export interface HistoryHandlers {
  appendEvent(input: unknown, context?: OperationContext): Promise<{ event: HistoryEvent }>;
  appendGameCoreEvent(input: unknown, context?: OperationContext): Promise<{ event: HistoryEvent; inserted: boolean }>;
  listForWeb(input: unknown, context?: OperationContext): Promise<Page<HistoryEvent>>;
  getForWeb(input: unknown, context?: OperationContext): Promise<{ event: HistoryEvent }>;
  searchEvents(input: unknown, context?: OperationContext): Promise<Page<HistoryEvent>>;
  getEvent(input: unknown, context?: OperationContext): Promise<{ event: HistoryEvent }>;
  categoriesList(input: unknown, context?: OperationContext): Promise<Page<CatalogRow>>;
  typesList(input: unknown, context?: OperationContext): Promise<Page<CatalogRow>>;
  typeGet(input: unknown, context?: OperationContext): Promise<{ type: CatalogRow }>;
  categoryCreate(input: unknown, context?: OperationContext): Promise<MutationResult>;
  categoryUpdate(input: unknown, context?: OperationContext): Promise<MutationResult>;
  typeCreate(input: unknown, context?: OperationContext): Promise<MutationResult>;
  typeUpdate(input: unknown, context?: OperationContext): Promise<MutationResult>;
  ready(): Promise<void>;
}
/** Сериализует JSON независимо от порядка ключей объектов. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
/** Нормализует RFC3339 в UTC, сохраняя все шесть знаков микросекунд. */
export function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HistoryFault("INVALID_ARGUMENT");
  const micro = ((value.match(/\.(\d+)/)?.[1] ?? "") + "000000").slice(0, 6);
  const utc = new Date(parsed).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith("0000-")) throw new HistoryFault("INVALID_ARGUMENT");
  return utc.slice(0, 19) + "." + micro + "Z";
}
/** Проверяет deadline между внешними шагами; не освобождает слот исполнения. */
export function checkContext(context?: OperationContext): void {
  if (context && (context.signal.aborted || performance.now() >= context.deadlineAt)) throw new HistoryFault("DEADLINE_EXCEEDED");
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => k.includes("\0") || hasNul(v));
  return false;
}
function input(tool: ToolName | "list" | "get", value: unknown): Record<string, any> {
  const valid = tool === "list" || tool === "get" ? validateNatsRequest(tool, value) : validateToolInput(tool, value);
  if (!valid || hasNul(value)) throw new HistoryFault("INVALID_ARGUMENT");
  if (bytes(value) > limits.maxRequestBytes) throw new HistoryFault("REQUEST_TOO_LARGE");
  // AIDEV-NOTE: Копия исключает изменение request отправителем во время await транзакции.
  return JSON.parse(JSON.stringify(value));
}
function response<T>(value: T, context?: OperationContext): T {
  if (bytes(value) > Math.min(limits.maxResponseBytes, context?.responseBudgetBytes ?? limits.maxResponseBytes)) throw new HistoryFault("RESULT_TOO_LARGE");
  return value;
}
function normalizedFilters(raw: Record<string, any> = {}): Filters {
  const filters = { ...raw };
  for (const name of ["occurred_from", "occurred_to"]) if (filters[name]) filters[name] = normalizeTimestamp(filters[name]);
  if (filters.occurred_from && filters.occurred_to && filters.occurred_from > filters.occurred_to) throw new HistoryFault("INVALID_ARGUMENT");
  return filters;
}
function normalizeEvent(raw: Record<string, any>): EventInput {
  return { id: raw.id.toLowerCase(), source: raw.source, type_id: raw.type_id, occurred_at: normalizeTimestamp(raw.occurred_at), actor_id: raw.actor_id ?? null, scope_type: raw.scope_type, scope_id: raw.scope_id, object_type: raw.object_type ?? null, object_id: raw.object_id ?? null, data: raw.data ?? {} };
}
function gameCoreEvent(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryFault("INVALID_ARGUMENT");
  const raw = value as Record<string, any>; const aggregate = raw.aggregate; const actor = raw.actor; const data = raw.data;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.event_id ?? "") || raw.event_version !== 1 || typeof raw.event_type !== "string" || !/^[a-z][a-z0-9_.]{1,95}$/.test(raw.event_type) || !/^\d{4}-/.test(raw.occurred_at ?? "") || typeof raw.owner_id !== "string" || raw.owner_id.length < 1 || raw.owner_id.length > 255 || !actor || typeof actor !== "object" || Array.isArray(actor) || !["human", "agent", "system"].includes(actor.kind) || (actor.id !== undefined && actor.id !== null && (typeof actor.id !== "string" || actor.id.length > 255)) || !aggregate || typeof aggregate !== "object" || Array.isArray(aggregate) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aggregate.id ?? "") || !["element", "move", "attempt"].includes(aggregate.kind) || !data || typeof data !== "object" || Array.isArray(data)) throw new HistoryFault("INVALID_ARGUMENT");
  const category = data.history_category_code, type = data.history_type_code; if (typeof category !== "string" || typeof type !== "string") throw new HistoryFault("INVALID_ARGUMENT");
  return raw;
}
function sameEvent(input: EventInput, saved: HistoryEvent): boolean {
  const { recorded_at, ...content } = saved;
  return canonical(input) === canonical(content);
}
function validCatalog(value: unknown, table: CatalogTable): value is CatalogRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as CatalogRow;
  return Number.isInteger(row.id) && row.id > 0 && row.id <= 2147483647 && /^[a-z][a-z0-9_]{0,63}$/.test(row.code) &&
    typeof row.name === "string" && Array.from(row.name).length > 0 && Array.from(row.name).length <= 128 &&
    typeof row.description === "string" && Array.from(row.description).length <= 512 &&
    Object.keys(row).sort().join(",") === (table === "sys_types" ? "category_id,code,description,id,name" : "code,description,id,name") &&
    (table !== "sys_types" || Number.isInteger((row as EventType).category_id) && (row as EventType).category_id > 0);
}
function replay(saved: HistoryEvent, operation: MutationOperation, request: MutationRequest, table: CatalogTable): MutationResult {
  const data = saved.data;
  const result = data.result as CatalogRow | undefined;
  const create = operation.endsWith("_create");
  const keys = Object.keys(data).sort().join(",");
  const validRow = validCatalog(result, table);
  const old = data.old as CatalogRow | null;
  const validOld = create ? old === null : validCatalog(old, table) && old.id === result?.id && old.code === result?.code &&
    (table !== "sys_types" || (old as EventType).category_id === (result as EventType)?.category_id);
  if (!validRow || !validOld || saved.id !== request.event_id || keys !== "new,old,operation,request,result" || data.operation !== operation || canonical(data.request) !== canonical(request) ||
    saved.source !== "service_history" || saved.scope_type !== "system" || saved.scope_id !== "service_history" || saved.type_id !== (create ? 101 : 102) ||
    saved.object_type !== table || saved.object_id !== String(result!.id) || saved.actor_id !== request.actor_id ||
    canonical(data.new) !== canonical(result) || (create ? data.old !== null || result!.code !== request.code : result!.id !== request.id || !data.old) ||
    result!.name !== request.name || result!.description !== request.description || (table === "sys_types" && create && (result as EventType).category_id !== request.category_id)) {
    throw new HistoryFault("EVENT_ID_CONFLICT");
  }
  return { result: result!, audit_event: saved };
}
/** Собирает чистые сценарии поверх транзакционного порта и секретного HMAC-ключа. */
export function createHistoryHandlers(store: HistoryStore, options: { cursorKey: string | Uint8Array }): HistoryHandlers {
  const key = Buffer.from(options.cursorKey);
  if (key.byteLength < 32) throw new Error("HISTORY_CURSOR_KEY_TOO_SHORT");
  function cursor(kind: string, binding: unknown, position: EventKey | number): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, kind, binding: createHash("sha256").update(canonical(binding)).digest("hex"), position })).toString("base64url");
    return payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
  }
  function decode(token: string | null | undefined, kind: string, binding: unknown): EventKey | number | null {
    if (!token) return null;
    try {
      const parts = token.split(".");
      if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw 0;
      const signature = Buffer.from(parts[1], "base64url");
      const expected = createHmac("sha256", key).update(parts[0]).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw 0;
      const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (value.v !== 1 || value.kind !== kind || value.binding !== createHash("sha256").update(canonical(binding)).digest("hex")) throw 0;
      if (kind === "events") {
        if (!Array.isArray(value.position) || value.position.length !== 3 || !value.position.every((x: unknown) => typeof x === "string") ||
          normalizeTimestamp(value.position[0]) !== value.position[0] || !/^[a-z][a-z0-9_]{0,63}$/.test(value.position[1]) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.position[2])) throw 0;
      } else if (!Number.isInteger(value.position) || value.position < 1) throw 0;
      return value.position;
    } catch { throw new HistoryFault("INVALID_CURSOR"); }
  }
  function page<T>(rows: T[], limit: number, kind: string, binding: unknown, position: (row: T) => EventKey | number, context?: OperationContext): Page<T> {
    let count = Math.min(limit, rows.length);
    while (count > 0) {
      const value = { items: rows.slice(0, count), next_cursor: rows.length > count ? cursor(kind, binding, position(rows[count - 1])) : null };
      if (bytes(value) <= Math.min(limits.maxResponseBytes, context?.responseBudgetBytes ?? limits.maxResponseBytes)) return value;
      count--;
    }
    if (rows.length) throw new HistoryFault("RESULT_TOO_LARGE");
    return response({ items: [], next_cursor: null }, context);
  }
  async function search(value: unknown, web: boolean, context?: OperationContext): Promise<Page<HistoryEvent>> {
    const raw = input(web ? "list" : "history_search", value);
    const filters = normalizedFilters(raw.filters);
    const userId = web ? raw.user_id as string : null;
    const binding = { filters, user_id: userId };
    const after = decode(raw.cursor, "events", binding) as EventKey | null;
    const limit = raw.limit ?? limits.defaultPageSize;
    return store.transaction(userId, context, async tx => page(await tx.events(filters, after, limit + 1), limit, "events", binding, row => [row.recorded_at, row.source, row.id], context));
  }
  async function get(value: unknown, web: boolean, context?: OperationContext): Promise<{ event: HistoryEvent }> {
    const raw = input(web ? "get" : "history_get", value);
    return store.transaction(web ? raw.user_id : null, context, async tx => {
      const event = await tx.event(raw.source, raw.id.toLowerCase());
      if (!event) throw new HistoryFault("NOT_FOUND");
      return response({ event }, context);
    });
  }
  async function catalogPage(value: unknown, table: CatalogTable, context?: OperationContext): Promise<Page<CatalogRow>> {
    const raw = input(table === "sys_categories" ? "history_categories_list" : "history_types_list", value);
    const binding = { category_id: raw.category_id ?? null };
    const after = decode(raw.cursor, table, binding) as number | null;
    const limit = raw.limit ?? limits.defaultPageSize;
    return store.transaction(null, context, async tx => page(await tx.catalogList(table, raw.category_id, after, limit + 1), limit, table, binding, row => row.id, context));
  }
  async function mutate(value: unknown, operation: MutationOperation, context?: OperationContext): Promise<MutationResult> {
    const raw = input(operation, value);
    const request = { ...raw, event_id: raw.event_id.toLowerCase(), actor_id: raw.actor_id ?? null } as MutationRequest;
    const table = operation.startsWith("history_category") ? "sys_categories" : "sys_types";
    const create = operation.endsWith("_create");
    return store.transaction(null, context, async tx => {
      await tx.lockEvent("service_history", request.event_id);
      const saved = await tx.event("service_history", request.event_id);
      if (saved) return response(replay(saved, operation, request, table), context);
      const old = create ? null : await tx.catalog(table, request.id!, true);
      if (!create && !old) throw new HistoryFault("NOT_FOUND");
      const result = create ? await tx.catalogInsert(table, request) : await tx.catalogUpdate(table, request);
      const eventInput: EventInput = { id: request.event_id, source: "service_history", type_id: create ? 101 : 102, occurred_at: normalizeTimestamp(new Date().toISOString()), actor_id: request.actor_id, scope_type: "system", scope_id: "service_history", object_type: table, object_id: String(result.id), data: { operation, request, old, new: result, result } };
      if (bytes({ ...eventInput, recorded_at: "2000-01-01T00:00:00.000000Z" }) > limits.maxEventBytes) throw new HistoryFault("REQUEST_TOO_LARGE");
      const audit = await tx.insertEvent(eventInput);
      // AIDEV-NOTE: Общий append использует тот же advisory lock, поэтому чужой self-event не может вклиниться между replay и аудитом.
      if (!audit) throw new HistoryFault("EVENT_ID_CONFLICT");
      return response({ result, audit_event: audit }, context);
    });
  }
  return {
    async appendGameCoreEvent(value, context) {
      const raw = gameCoreEvent(value);
      return store.transaction(null, context, async tx => {
        const catalog = await tx.typeByCode(raw.data.history_category_code, raw.data.history_type_code);
        if (!catalog) throw new HistoryFault("INVALID_ARGUMENT");
        const input: EventInput = { id: raw.event_id.toLowerCase(), source: "service_game_core", type_id: catalog.id, occurred_at: normalizeTimestamp(raw.occurred_at), actor_id: raw.actor?.id ?? null, scope_type: "user", scope_id: raw.owner_id, object_type: raw.aggregate.kind, object_id: raw.aggregate.id.toLowerCase(), data: raw };
        const inserted = await tx.insertEvent(input); const saved = inserted ?? await tx.event(input.source, input.id); if (!saved) throw new HistoryFault("INTERNAL"); if (!inserted && !sameEvent(input, saved)) throw new HistoryFault("EVENT_ID_CONFLICT"); return { event: saved, inserted: !!inserted };
      });
    },
    async appendEvent(value, context) {
      const event = normalizeEvent(input("history_append", value));
      if (event.source === "service_history" && ["sys_categories", "sys_types"].includes(event.object_type ?? "")) throw new HistoryFault("INVALID_ARGUMENT");
      if (bytes({ ...event, recorded_at: "2000-01-01T00:00:00.000000Z" }) > limits.maxEventBytes) throw new HistoryFault("REQUEST_TOO_LARGE");
      return store.transaction(null, context, async tx => {
        if (event.source === "service_history") await tx.lockEvent(event.source, event.id);
        const inserted = await tx.insertEvent(event);
        const saved = inserted ?? await tx.event(event.source, event.id);
        if (!saved || !sameEvent(event, saved)) throw new HistoryFault("EVENT_ID_CONFLICT");
        return response({ event: saved }, context);
      });
    },
    listForWeb: (value, context) => search(value, true, context),
    searchEvents: (value, context) => search(value, false, context),
    getForWeb: (value, context) => get(value, true, context),
    getEvent: (value, context) => get(value, false, context),
    categoriesList: (value, context) => catalogPage(value, "sys_categories", context),
    typesList: (value, context) => catalogPage(value, "sys_types", context),
    async typeGet(value, context) {
      const raw = input("history_type_get", value);
      return store.transaction(null, context, async tx => {
        const row = await tx.catalog("sys_types", raw.id);
        if (!row) throw new HistoryFault("NOT_FOUND");
        return response({ type: row }, context);
      });
    },
    categoryCreate: (value, context) => mutate(value, "history_category_create", context),
    categoryUpdate: (value, context) => mutate(value, "history_category_update", context),
    typeCreate: (value, context) => mutate(value, "history_type_create", context),
    typeUpdate: (value, context) => mutate(value, "history_type_update", context),
    ready: () => store.ready()
  };
}
