// ABOUTME: Задаёт порты приложения local-ai к runtime, artifacts и хранилищу.
// ABOUTME: Контракты не раскрывают transport, SQL и устройство соседних сервисов.
import type {
  ClaimedOutboxEvent, DeliveryErrorCode, EmbedInput, EmbedOutput,
  LocalAiTx, OperationContext, ResolvedModel, TranscribeInput, TranscribeOutput,
} from './types.js';

/** Открывает выбранную установленную модель и возвращает только готовый к вызовам runtime. */
export interface RuntimeFactory {
  open(model: ResolvedModel, context: OperationContext): Promise<RuntimePort>;
}

/** Выполняет задачи выбранного профиля; exited разрешается только после фактической остановки процесса. */
export interface RuntimePort {
  readonly exited: Promise<void>;
  embed(input: EmbedInput, context: OperationContext): Promise<EmbedOutput>;
  transcribe(input: TranscribeInput, context: OperationContext): Promise<TranscribeOutput>;
  close(): Promise<void>;
}

/** Блокирует новую работу и выдаёт проверенный участок изменения только при отсутствии занятых слотов. */
export interface ModelIdleGuard {
  withModelIdleLock<T>(modelId: string, callback: () => Promise<T>): Promise<T>;
}

/** Уведомляет lifecycle об изменённых настройках после фиксации транзакции БД. */
export interface ModelSettingsChangedPort {
  settingsChanged(modelId: string, settings: { idleUnloadSeconds: number | null }): void;
}

/** Предоставляет временный путь только внутри callback и очищает рабочую копию после его завершения. */
export interface ArtifactPort {
  withReadyAudio<T>(
    input: { artifactId: string; ownerId: string; operationId: string },
    context: OperationContext,
    use: (audio: { localPath: string }) => Promise<T>,
  ): Promise<T>;
}

/** Объединяет изменение состояния и добавление разрешённого metadata event одной транзакцией. */
export interface LocalAiStore {
  transaction<T>(run: (tx: LocalAiTx) => Promise<T>): Promise<T>;
  recoverInterrupted(): Promise<number>;
}

/** Доставляет сохранённые facts с lease fencing; permanent failure остаётся учтённым. */
export interface OutboxDeliveryPort {
  claimBatch(limit: number, leaseMs: number): Promise<readonly ClaimedOutboxEvent[]>;
  acknowledge(eventId: string, claimToken: string): Promise<void>;
  fail(
    eventId: string,
    claimToken: string,
    retryAt: string | null,
    errorCode: DeliveryErrorCode,
  ): Promise<void>;
  status(): Promise<{
    reserved: number;
    pending: number;
    sending: number;
    permanentlyFailed: number;
    oldestCreatedAt: string | null;
    lastErrorCode: DeliveryErrorCode | null;
  }>;
}
