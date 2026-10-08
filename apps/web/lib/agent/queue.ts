// ABOUTME: Определяет данные и операции сохраняемой очереди сообщений Агента.
// ABOUTME: Владеет типами очереди и освобождает только созданные локальные preview URL.
import type { AgentMode, PermissionMode } from "@brai/agent/contracts";
import type { ComposerDraft } from "./images";

/** Адресует очередь конкретного пользователя, проекта и треда. */
export type QueueScope = { userId: string; projectId: string; threadId: string };

/** Настройки, сохранённые вместе с черновиком при постановке в очередь. */
export type QueueSettings = { model: string; effort: string; permissionMode: PermissionMode; agentMode: AgentMode };

/** Стабильная идентичность попытки отправки, записываемая до внешней мутации. */
export type QueueAttempt = { operationId: string; action: "start" | "steer"; generation: string; expectedTurnId?: string };

/** Сохраняемый черновик одной операции в очереди. */
export type QueueEntry = {
  id: string;
  scope: QueueScope;
  generation: string;
  draft: ComposerDraft;
  settings: QueueSettings;
  state: "waiting" | "sending" | "failed" | "unknown";
  attempt?: QueueAttempt;
  error?: string;
};

/** Версия очереди и её записи, прочитанные для одного scope. */
export type QueueSnapshot = { scope: QueueScope; revision: number; entries: QueueEntry[] };

/** Адаптер постоянного хранилища с CAS по версии scope. */
export type QueueStore = {
  /** Загружает отдельную hydrated-копию очереди указанного scope. */
  load(scope: QueueScope): Promise<QueueSnapshot>;
  /** Атомарно заменяет scope, если версия совпадает и лимит пользователя не превышен. */
  save(scope: QueueScope, expectedRevision: number, entries: QueueEntry[]): Promise<QueueSnapshot>;
  /** Закрывает соединение; URL возвращённых снимков остаются у их владельца. */
  close(): void;
};

/** Максимальное число записей очереди на пользователя во всех его scope. */
export const QUEUE_LIMIT = 16;

/** Возвращает ключ scope, пригодный для ключа IndexedDB без неоднозначной склейки полей. */
export function queueScopeKey(scope: QueueScope): string {
  return JSON.stringify([scope.userId, scope.projectId, scope.threadId]);
}

/** Освобождает preview URL изображений, принадлежащих переданным записям. */
export function releaseQueueEntries(entries: QueueEntry[]): void {
  for (const entry of entries) {
    for (const image of entry.draft.images) {
      if (image.previewObjectUrl) URL.revokeObjectURL(image.previewUrl);
    }
  }
}
