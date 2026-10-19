// ABOUTME: Задаёт порты приложения local-ai к runtime, artifacts и хранилищу.
// ABOUTME: Контракты не раскрывают transport, SQL и устройство соседних сервисов.
import type {
  EmbedInput, EmbedOutput, LocalAiHistoryMetadataEvent,
  LocalAiTx, OperationContext, ResolvedModel, TranscribeInput, TranscribeOutput, SynthesizeInput, SynthesizeOutput,
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
  synthesize?(input: SynthesizeInput, context: OperationContext): Promise<SynthesizeOutput>;
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
  /** Публикует готовое Ogg/Opus аудио владельцу; возвращает только ready artifact ID. */
  publishAudio?(input: { audio: Uint8Array; mimeType: 'audio/ogg' }, context: OperationContext): Promise<{ artifactId: string }>;
  /** Проверяет владельца media-артефакта и удерживает файл до окончания callback. */
  withReadyMedia?<T>(
    input: { artifactId: string; ownerId: string; operationId: string; kind: 'image_artifact' | 'audio_artifact' | 'video_artifact' },
    context: OperationContext,
    use: (media: { localPath: string; mimeType: string }) => Promise<T>,
  ): Promise<T>;
  withReadyAudio<T>(
    input: { artifactId: string; ownerId: string; operationId: string },
    context: OperationContext,
    use: (audio: { localPath: string }) => Promise<T>,
  ): Promise<T>;
}

/** Фиксирует каталог, настройки и операции установки независимо от истории. */
export interface LocalAiStore {
  transaction<T>(run: (tx: LocalAiTx) => Promise<T>): Promise<T>;
  recoverInterrupted(): Promise<number>;
}

/** Публикует один короткий факт без ожидания, подтверждения и повторов. */
export interface HistoryFactPort {
  publish(event: LocalAiHistoryMetadataEvent): void;
}
