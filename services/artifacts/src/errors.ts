// ABOUTME: Задаёт безопасные ошибки границы artifacts.
// ABOUTME: Транспорт получает код и статус без сообщений драйверов и токенов.
export type ArtifactErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "PAYLOAD_TOO_LARGE" | "OVERLOADED" | "INTERNAL" | "STORAGE_UNAVAILABLE" | "SHARING_NOT_CONFIGURED";
const statuses: Record<ArtifactErrorCode, number> = {INVALID_ARGUMENT:400,NOT_FOUND:404,CONFLICT:409,PAYLOAD_TOO_LARGE:413,OVERLOADED:429,INTERNAL:500,STORAGE_UNAVAILABLE:503,SHARING_NOT_CONFIGURED:503};
/** Ошибка с безопасным публичным сообщением; cause не предназначен для журналов. */
export class ArtifactError extends Error {
  readonly status: number;
  constructor(readonly code: ArtifactErrorCode, options?: ErrorOptions) {super(code, options);this.name="ArtifactError";this.status=statuses[code];}
}
/** Сохраняет прикладные ошибки и скрывает детали отказов хранилища. */
export function storageError(error: unknown): ArtifactError {
  return error instanceof ArtifactError ? error : new ArtifactError("STORAGE_UNAVAILABLE", {cause:error});
}
