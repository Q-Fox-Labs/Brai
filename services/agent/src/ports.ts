// ABOUTME: Определяет порт подключения сценариев agent к Codex app-server.
// ABOUTME: Не содержит транспорта, хранилища состояния ходов или upstream account-данных.

/** Идентификатор RPC сохраняет исходный тип, присланный app-server. */
export type RawRequestId = string | number;

/** Состояние транспорта и безопасное перечисление авторизации. */
export interface CodexStatus {
  generation: string | null;
  connection: 'connected' | 'connecting' | 'disconnected';
  authorization: 'ready' | 'required' | 'failed' | 'unknown';
  eventOverflow: boolean;
}

/** Наблюдение о сообщении Codex или переходе соединения. */
export type CodexObservation =
  | { type: 'notification'; method: string; params: Record<string, unknown> }
  | { type: 'request'; method: string; params: Record<string, unknown>; id: RawRequestId; supported: boolean; code?: string }
  | { type: 'connection'; status: CodexStatus; code?: string };

/** Опции одной RPC-операции; mutation запрещает автоматические повторы. */
export interface CodexCallOptions {
  mutation: boolean;
  timeoutMs?: number;
}

/** Ошибка транспорта/протокола с безопасной классификацией исхода. */
export interface CodexPortError extends Error {
  code: string;
  outcome: 'not-sent' | 'unknown' | 'query';
  upstreamCode?: number;
}

/** Порт к одному явному Unix WebSocket endpoint app-server. */
export interface CodexPort {
  /** Подключиться и завершить initialize/initialized до разрешения Promise. */
  connect(): Promise<void>;
  /** Вызвать поддерживаемый OpenRPC-метод без автоматического повтора. */
  call(method: string, params: Record<string, unknown>, options: CodexCallOptions): Promise<unknown>;
  /** Передать ответ server request с сохранением исходного ID. */
  respond(rawRequestId: RawRequestId, answer: unknown): Promise<void>;
  /** Подписаться на уведомления, запросы и переходы соединения. */
  subscribe(listener: (event: CodexObservation) => void | Promise<void>): () => void;
  /** Вернуть только безопасный статус транспорта и авторизации. */
  status(): CodexStatus;
  /** Закрыть соединение и завершить ожидающие вызовы. */
  close(): Promise<void>;
}

/** Конфигурация подключения к уже запущенному app-server. */
export interface CodexOptions {
  /** Явный ws+unix endpoint вида ws+unix:/path/to/socket:/; default отсутствует. */
  socketUrl: string;
  /** Размер кадра в байтах; по умолчанию 2 MiB. */
  maxFrameBytes?: number;
  /** Максимальное число незавершённых исходящих RPC; по умолчанию 64. */
  maxPending?: number;
  /** Максимум ожидающих доставки наблюдений; по умолчанию 256. */
  maxEvents?: number;
  /** Время handshake/инициализации в миллисекундах. */
  connectTimeoutMs?: number;
  /** Имя и версия клиента, отправляемые в initialize. */
  clientInfo?: { name: string; version: string };
}
