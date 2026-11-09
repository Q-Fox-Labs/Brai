// ABOUTME: Измеряет продолжительность внешних действий выпуска Codeworks.
// ABOUTME: Не записывает аргументы, результаты вызовов или пользовательские данные.
import { performance } from 'node:perf_hooks';

/** Выполнить действие и сообщить его безопасное имя, результат и длительность в миллисекундах. */
export async function measureReleaseStep(operationId, step, action, {emit = console.info, now = () => performance.now()} = {}) {
  const started = now();
  let outcome = 'failed';
  try {
    const result = await action();
    outcome = 'succeeded';
    return result;
  } finally {
    const event = {operation_id: operationId, step, outcome, at: new Date().toISOString(), duration_ms: Math.max(0, Math.round(now() - started))};
    // AIDEV-NOTE: Диагностика не меняет результат уже начатой внешней операции.
    try { emit('CODEWORKS_RELEASE_TIMING ' + JSON.stringify(event)); } catch {}
  }
}

/** Сообщить переход состояния: время между событиями показывает очередь и ожидания. */
export function recordReleaseState(operationId, status, step, {emit = console.info, now = () => new Date()} = {}) {
  try { emit('CODEWORKS_RELEASE_STATE ' + JSON.stringify({operation_id: operationId, status, step, at: now().toISOString()})); } catch {}
}
