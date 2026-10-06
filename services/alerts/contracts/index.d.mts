// ABOUTME: Описывает публичные типы схем alerts для TypeScript-потребителей.
// ABOUTME: Реализация и проверки остаются в owner index.mjs и JSON Schema.
export type Operation = 'list' | 'get' | 'summary' | 'read' | 'read_all';
export interface Category { id: number; code: string; name: string; description: string; color: string; importance: 1 | 2 | 3 }
export interface NotificationType { id: number; category_id: number; code: string; name: string; description: string }
export interface NotificationInput { id: string; service_id: string; type_id: number; scope_type: 'user' | 'system'; scope_id: string; title: string; text: string; data?: Record<string, unknown>; occurred_at: string }
export interface Notification extends NotificationInput { data: Record<string, unknown>; recorded_at: string; category: Category; type: NotificationType; read_at: string | null }
export interface Summary { unread_count: number; category: Omit<Category, 'description'> | null }
export interface ListResponse { items: Notification[]; next_cursor: string | null }
export type ErrorCode = 'INVALID_ARGUMENT' | 'INVALID_CURSOR' | 'REQUEST_TOO_LARGE' | 'RESULT_TOO_LARGE' | 'NOT_FOUND' | 'EVENT_ID_CONFLICT' | 'UNKNOWN_TYPE' | 'BUSY' | 'DATABASE_UNAVAILABLE' | 'DEADLINE_EXCEEDED' | 'INTERNAL';
export const schema: Record<string, any>;
export const limits: Readonly<{ maxRequestBytes: number; maxEventBytes: number; maxResponseBytes: number; defaultPageSize: number; maxPageSize: number; active: number; queue: number; deadlineMs: number }>;
export const subjects: Readonly<Record<Operation | 'ingest' | 'changed', string>>;
export const errorStatus: Readonly<Record<ErrorCode, number>>;
/** Проверяет точную форму запроса, не меняя его значения. */
export function validateRequest(operation: Operation, value: unknown): boolean;
/** Проверяет ответ операции по публичной схеме владельца. */
export function validateResponse(operation: Operation, value: unknown): boolean;
/** Проверяет долговечный вход. */
export function validateIngest(value: unknown): value is NotificationInput;
/** Проверяет безопасный сигнал обновления. */
export function validateChanged(value: unknown): value is { user_id: string | null };
/** Проверяет безопасную сервисную ошибку. */
export function validateError(value: unknown): value is { code: ErrorCode; message: string; retryable: boolean };
