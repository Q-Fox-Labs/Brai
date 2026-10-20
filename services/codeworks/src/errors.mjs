// ABOUTME: Определяет безопасные предметные ошибки Codeworks.
// ABOUTME: SQL, команды и секреты не передаются через публичные ответы.
export const errorStatus = {
  INVALID_ARGUMENT: 400, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409,
  WRITER_BUSY: 409, OWNERSHIP_CONFLICT: 409, DEPENDENCIES_INCOMPATIBLE: 422,
  GIT_FAILED: 422, BUSY: 503, INTERNAL: 500,
};
/** Ошибка границы с безопасной причиной; не принимает stderr внешних программ. */
export class Fault extends Error {
  constructor(code, message = code) { super(message); this.name = 'CodeworksFault'; this.code = code; }
  /** Возвращает DTO, пригодный для обоих транспортов. */
  dto() { return { code: this.code, message: this.message, retryable: this.code === 'BUSY' }; }
}
/** Скрывает непредвиденные инфраструктурные сообщения от вызывающей стороны. */
export function safeFault(error) { return error instanceof Fault ? error : new Fault('INTERNAL'); }
