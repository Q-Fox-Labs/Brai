// ABOUTME: Выполняет идемпотентную запись, чтение и индивидуальное прочтение уведомлений.
// ABOUTME: PostgreSQL и NATS подключаются явными портами; ядро не зависит от транспорта.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { limits, validateIngest, validateRequest, type ErrorCode, type ListResponse, type Notification, type NotificationInput, type Operation, type Summary } from '../contracts/index.mjs';

export type EventInput = NotificationInput & { data: Record<string, unknown> };
export type EventKey = [string, string, string];
export interface OperationContext { deadlineAt: number; signal: AbortSignal }
/** Безопасная ошибка; message не включает текст уведомления, SQL или реквизиты. */
export class AlertsFault extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ErrorCode) { super(code); this.name = 'AlertsFault'; this.retryable = ['BUSY', 'DATABASE_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(code); }
}
/** Транзакция живёт только внутри callback; все строки уже ограничены user-контекстом. */
export interface AlertsTransaction {
  insert(input: EventInput): Promise<boolean>;
  typeByCode(code: string): Promise<number | null>;
  get(serviceId: string, id: string): Promise<Notification | null>;
  list(after: EventKey | null, count: number): Promise<Notification[]>;
  summary(): Promise<Summary>;
  read(serviceId: string, id: string): Promise<boolean>;
  readAll(): Promise<boolean>;
}
/** Resolve означает завершённый COMMIT и освобождённое соединение. */
export interface AlertsStore {
  transaction<T>(userId: string | null, context: OperationContext | undefined, run: (tx: AlertsTransaction) => Promise<T>): Promise<T>;
  ready(): Promise<void>;
}
/** Входные сценарии для долговечного ingestion и доверенных web-команд. */
export interface AlertsHandlers {
  ingest(value: unknown, context?: OperationContext): Promise<{ inserted: boolean; user_id: string | null }>;
  ingestElementsEvent(value: unknown, context?: OperationContext): Promise<{ inserted: boolean; user_id: string | null }>;
  execute(operation: Operation, value: unknown, context?: OperationContext): Promise<ListResponse | { notification: Notification } | Summary>;
  ready(): Promise<void>;
}
/** Проверяет общий срок до следующего внешнего действия. */
export function checkContext(context?: OperationContext): void {
  if (context && (context.signal.aborted || performance.now() >= context.deadlineAt)) throw new AlertsFault('DEADLINE_EXCEEDED');
}
/** Сравнивает JSON независимо от порядка ключей объектов. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
}
/** Нормализует RFC3339 в UTC, сохраняя микросекунды. */
export function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AlertsFault('INVALID_ARGUMENT');
  const utc = new Date(parsed).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith('0000-')) throw new AlertsFault('INVALID_ARGUMENT');
  return utc.slice(0, 19) + '.' + ((value.match(/\.(\d+)/)?.[1] ?? '') + '000000').slice(0, 6) + 'Z';
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
function nul(value: unknown): boolean {
  const remaining = [value];
  while (remaining.length) {
    const item = remaining.pop();
    if (typeof item === 'string' && item.includes('\0')) return true;
    if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) { if (k.includes('\0')) return true; remaining.push(v); }
  }
  return false;
}
function input(operation: Operation | 'ingest', value: unknown): Record<string, any> {
  try {
    if (size(value) > limits.maxRequestBytes) throw new AlertsFault('REQUEST_TOO_LARGE');
    if (!(operation === 'ingest' ? validateIngest(value) : validateRequest(operation, value)) || nul(value)) throw new AlertsFault('INVALID_ARGUMENT');
    return JSON.parse(JSON.stringify(value));
  } catch (error) { if (error instanceof AlertsFault) throw error; throw new AlertsFault('INVALID_ARGUMENT'); }
}
/** Создаёт ядро со стабильным ключом курсоров и необязательным сигналом после commit. */
export function createAlertsHandlers(store: AlertsStore, options: { cursorKey: Uint8Array; changed?: (userId: string | null) => void }): AlertsHandlers {
  const key = Buffer.from(options.cursorKey);
  if (key.length < 32) throw new Error('ALERTS_CURSOR_KEY_TOO_SHORT');
  function cursor(userId: string, position: EventKey): string {
    // AIDEV-NOTE: V2 занимает не более 1532 символов для 255 Unicode code points; JSON escaping не увеличивает ID.
    const body = Buffer.concat([Buffer.from([2]), createHmac('sha256', key).update(userId).digest(), Buffer.from(position[0], 'ascii'), Buffer.from(position[2], 'ascii'), Buffer.from(position[1], 'utf8')]).toString('base64url');
    return body + '.' + createHmac('sha256', key).update(body).digest('base64url');
  }
  function decode(userId: string, token: string | null | undefined): EventKey | null {
    if (!token) return null;
    try {
      const [body, signature, extra] = token.split('.');
      if (extra || !body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw 0;
      const supplied = Buffer.from(signature, 'base64url');
      const expected = createHmac('sha256', key).update(body).digest();
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw 0;
      const bytes = Buffer.from(body, 'base64url');
      let value;
      if (bytes[0] === 2) {
        if (bytes.length < 97 || bytes.length > 1116 || !timingSafeEqual(bytes.subarray(1, 33), createHmac('sha256', key).update(userId).digest())) throw 0;
        value = { v: 1, user_id: userId, position: [bytes.subarray(33, 60).toString('ascii'), new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(96)), bytes.subarray(60, 96).toString('ascii')] };
      } else {
        // AIDEV-NOTE: Прежние HMAC курсоры V1 остаются действительны после смены image.
        value = JSON.parse(bytes.toString('utf8'));
      }
      if (value.v !== 1 || value.user_id !== userId || !Array.isArray(value.position) || value.position.length !== 3 || !value.position.every((v: unknown) => typeof v === 'string') ||
        normalizeTimestamp(value.position[0]) !== value.position[0] || [...value.position[1]].length < 1 || [...value.position[1]].length > 255 || value.position[1].includes('\0') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.position[2])) throw 0;
      return value.position;
    } catch { throw new AlertsFault('INVALID_CURSOR'); }
  }
  function changed(userId: string | null): void {
    // AIDEV-NOTE: Core-сигнал не является доставкой данных. Сбой сигнала после commit не превращает успешную запись в отказ.
    try { options.changed?.(userId); } catch { console.error(JSON.stringify({ service: 'service_alerts', result: 'changed_signal_failed' })); }
  }
  function bounded<T>(result: T): T {
    if (size(result) > limits.maxResponseBytes) throw new AlertsFault('RESULT_TOO_LARGE');
    return result;
  }
  return {
    ready: () => store.ready(),
    async ingest(value, context) {
      const raw = input('ingest', value);
      const event: EventInput = { ...raw, id: raw.id.toLowerCase(), occurred_at: normalizeTimestamp(raw.occurred_at), data: raw.data ?? {} } as EventInput;
      if (size({ ...event, recorded_at: '2000-01-01T00:00:00.000000Z' }) > limits.maxEventBytes) throw new AlertsFault('REQUEST_TOO_LARGE');
      let expected: string;
      try { expected = canonical(event); } catch { throw new AlertsFault('INVALID_ARGUMENT'); }
      const inserted = await store.transaction(null, context, async tx => {
        const inserted = await tx.insert(event);
        const saved = await tx.get(event.service_id, event.id);
        if (!saved) throw new AlertsFault('INTERNAL');
        const { recorded_at, category, type, read_at, ...content } = saved;
        if (expected !== canonical(content)) throw new AlertsFault('EVENT_ID_CONFLICT');
        return inserted;
      });
      const user_id = event.scope_type === 'user' ? event.scope_id : null;
      if (inserted) changed(user_id);
      return { inserted, user_id };
    },
    async ingestElementsEvent(value, context) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AlertsFault("INVALID_ARGUMENT");
      const raw = value as Record<string, any>; const notification = raw.notification;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.event_id ?? "") || typeof raw.owner_id !== "string" || raw.owner_id.length < 1 || raw.owner_id.length > 255 || typeof raw.occurred_at !== "string" || !notification || typeof notification !== "object" || Array.isArray(notification) || typeof notification.type_code !== "string" || typeof notification.title !== "string" || notification.title.length < 1 || notification.title.length > 256 || typeof notification.text !== "string" || notification.text.length > 8192 || (notification.data !== undefined && (!notification.data || typeof notification.data !== "object" || Array.isArray(notification.data)))) throw new AlertsFault("INVALID_ARGUMENT");
      const event = { id: raw.event_id.toLowerCase(), service_id: "service_elements", scope_type: "user" as const, scope_id: raw.owner_id, title: notification.title, text: notification.text, data: notification.data ?? {}, occurred_at: normalizeTimestamp(raw.occurred_at) } as any;
      const inserted = await store.transaction(null, context, async tx => { const typeId = await tx.typeByCode(notification.type_code); if (!typeId) throw new AlertsFault("UNKNOWN_TYPE"); event.type_id = typeId; return tx.insert(event); });
      if (inserted) changed(raw.owner_id); return { inserted, user_id: raw.owner_id };
    },
    async execute(operation, value, context) {
      const raw = input(operation, value);
      let didChange = false;
      const result = await store.transaction(raw.user_id, context, async tx => {
        if (operation === 'list') {
          const limit = raw.limit ?? limits.defaultPageSize;
          const rows = await tx.list(decode(raw.user_id, raw.cursor), limit + 1);
          let count = Math.min(limit, rows.length);
          while (count > 0) {
            const last = rows[count - 1];
            const page = { items: rows.slice(0, count), next_cursor: rows.length > count ? cursor(raw.user_id, [last.recorded_at, last.service_id, last.id]) : null };
            if (size(page) <= limits.maxResponseBytes) return page;
            count--;
          }
          if (rows.length) throw new AlertsFault('RESULT_TOO_LARGE');
          return { items: [], next_cursor: null };
        }
        if (operation === 'get' || operation === 'read') {
          const notification = await tx.get(raw.service_id, raw.id.toLowerCase());
          if (!notification) throw new AlertsFault('NOT_FOUND');
          if (operation === 'get') return bounded({ notification });
          didChange = await tx.read(raw.service_id, raw.id.toLowerCase());
        }
        if (operation === 'read_all') didChange = await tx.readAll();
        return bounded(await tx.summary());
      });
      if (didChange) changed(raw.user_id);
      return result;
    },
  };
}
