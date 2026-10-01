// ABOUTME: Создаёт безопасные ошибки вызовов Codex с классификацией исхода.
// ABOUTME: Не включает сырые сообщения, параметры или содержимое ответов upstream.

import type { CodexPortError } from './ports.js';

/** Ошибка Codex без пользовательских данных и сырых upstream сообщений. */
export class CodexError extends Error implements CodexPortError {
  readonly code: string;
  readonly outcome: 'not-sent' | 'unknown' | 'query';
  readonly upstreamCode?: number;

  /** Создать классифицированную ошибку порта. */
  constructor(
    code: string,
    outcome: CodexPortError['outcome'],
    upstreamCode?: number,
  ) {
    super(code);
    this.name = 'CodexError';
    this.code = code;
    this.outcome = outcome;
    this.upstreamCode = upstreamCode;
  }
}
