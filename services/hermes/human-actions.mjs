// ABOUTME: Связывает доверенный Telegram callback с человеческой попыткой game-core.
// ABOUTME: Этот порт не регистрируется в обычном MCP и не удостоверяет Telegram пользователя.
import { fault } from './runtime.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const uncertain = error => typeof error.code !== 'string' || ['TIMEOUT', 'DEADLINE_EXCEEDED', 'CONNECTION_CLOSED', 'INVALID_UPSTREAM_RESPONSE'].includes(error.code);

/** Текст решения из текущей ревизии; порядок не зависит от порядка строк graph. */
function confirmationText(graph, move, target, inputs = move.input ?? []) {
  if (!move.fields?.planning) return undefined;
  if (move.fields.planning.decision === 'confirm') {
    const pending = graph.moves.filter(item => (item.targetId === target.id || item.ownerId === target.id) && item.status !== 'cancelled');
    const ordered = [];
    while (pending.length) {
      const index = pending.findIndex(item => !pending.some(other => other.id === item.previousId));
      if (index < 0) throw fault('INVALID_UPSTREAM_RESPONSE');
      ordered.push(...pending.splice(index, 1));
    }
    const fields = target.fields ?? {};
    return [target.title, `Результат: ${fields.expected_result || target.description || target.title}`,
      fields.constraints ? `Условия: ${fields.constraints}` : '', 'Ходы:',
      ...ordered.map((item, index) => `${index + 1}. ${item.kind === 'action' ? '👤' : '🤖'} ${item.title}${item.status === 'succeeded' ? ' — готово' : ''}`),
      'Принять — согласовать этот план. Работа начнётся после подтверждения.'].filter(Boolean).join('\n');
  }
  if (move.fields.planning.decision === 'final') {
    const resources = (graph.resources ?? []).filter(resource => inputs.includes(resource.id) && !resource.metadata?.stage);
    if (!resources.length) return null;
    return [target.title, ...resources.map(resource => `${resource.title}\n${resource.content}`),
      'Принять — принять показанный результат.'].join('\n\n');
  }
  return undefined;
}

/** Создаёт private порт; вызывающий обязан проверить owner-private chat и одноразовый callback token. */
export function createHumanActions(runtime) {
  async function lookup({ moveId }, signal) {
    if (!uuid(moveId)) throw fault('INVALID_ARGUMENT');
    const graph = await runtime.graph(signal), move = graph.moves.find(move => move.id === moveId);
    if (!move) throw fault('NOT_FOUND');
    if (move.kind !== 'action') throw fault('FORBIDDEN');
    const target = graph.elements.find(element => element.id === move.targetId);
    if (!target) throw fault('INVALID_UPSTREAM_RESPONSE');
    const planning = move.fields?.planning;
    // AIDEV-NOTE: Кнопка записывает только решение; предметные выходы human work нельзя получить из клика.
    const confirmationStage = planning && Array.isArray(planning.output_contracts) && planning.output_contracts.length === 1
      ? (planning.decision === 'confirm' ? 'planning' : planning.decision === 'final' ? 'final' : null) : null;
    const action = { ...(planning ? { confirmationStage, confirmationText: confirmationText(graph, move, target) } : {}), moveId, revisionId: target.revision, targetId: target.id, title: move.title, status: move.status,
      attemptId: move.attemptId || null, attemptStatus: graph.attempts.find(attempt => attempt.id === move.attemptId)?.status ?? null,
      attemptExecutorKind: move.executor ?? null, inputResourceIds: move.input ?? [], targetTitle: target.title, targetDescription: target.description };
    return { action, graph, move, target };
  }
  return {
    async read(args, signal) {
      if (!exact(args, ['moveId'])) throw fault('INVALID_ARGUMENT');
      return (await lookup(args, signal)).action;
    },
    /** Закрепляет human attempt до показа кнопки; повтор прежнего ключа не создаёт новую попытку. */
    async prepare(args, signal) {
      if (!exact(args, ['moveId', 'revisionId', 'idempotencyKey', 'inputResourceIds']) || !uuid(args.revisionId) ||
        typeof args.idempotencyKey !== 'string' || !args.idempotencyKey || args.idempotencyKey.length > 200 ||
        args.inputResourceIds !== undefined && (!Array.isArray(args.inputResourceIds) || args.inputResourceIds.some(id => !uuid(id)))) throw fault('INVALID_ARGUMENT');
      const { action, graph, move, target } = await lookup(args, signal);
      // AIDEV-NOTE: Claimed допускает только восстановление прежнего ключа после crash до записи attemptId в Telegram.
      if (action.revisionId !== args.revisionId && action.status !== 'claimed') throw fault('STALE_ACTION');
      if (!['planned', 'claimed'].includes(action.status)) throw fault('STALE_ACTION');
      // Claimed same-key recovery остаётся доступен для отмены даже неподдерживаемой прежней кнопки.
      if (action.status === 'planned' && action.confirmationStage === null) throw fault('HUMAN_OUTPUT_REQUIRED');
      let inputs = args.inputResourceIds;
      if (!inputs) {
        const available = await runtime.elementsCall('elements_moves_available', {}, signal);
        const ready = available.items?.find(move => move.id === args.moveId);
        inputs = ready?.required_resource_ids ?? ready?.available_resource_ids ?? (action.status === 'claimed' ? action.inputResourceIds : undefined);
        if (!inputs) throw fault('INPUT_RESOURCES_REQUIRED');
      }
      try {
        const result = await runtime.elementsCall('elements_move_claim', { move_id: args.moveId,
          idempotency_key: `telegram:${args.idempotencyKey}`, executor_kind: 'human', input_resource_ids: inputs }, signal);
        if (!uuid(result.attempt?.id) || result.attempt.executor_kind !== 'human') throw fault('INVALID_UPSTREAM_RESPONSE');
        if (result.attempt.status !== 'running' || action.status === 'claimed' && result.attempt.id !== action.attemptId) throw fault('STALE_ACTION');
        return { ...action, ...(move.fields?.planning ? { confirmationText: confirmationText(graph, move, target, inputs) } : {}), revisionId: args.revisionId, currentRevisionId: action.revisionId, attemptId: result.attempt.id, status: result.attempt.status, inputResourceIds: inputs };
      } catch (error) {
        if (uncertain(error)) throw fault('OUTCOME_UNKNOWN');
        throw error;
      }
    },
    /** Завершает только сохранённую human attempt; planning revision дополнительно проверяет owner в транзакции. */
    async complete(args, signal) {
      if (!exact(args, ['moveId', 'attemptId', 'revisionId', 'stage', 'decision', 'comment', 'source']) || !uuid(args.attemptId) || !uuid(args.revisionId) ||
        !['planning', 'final', 'review'].includes(args.stage) || !['approved', 'success', 'changes', 'cancelled'].includes(args.decision) ||
        args.comment !== undefined && (typeof args.comment !== 'string' || args.comment.length > 16_000)) throw fault('INVALID_ARGUMENT');
      const { action } = await lookup(args, signal);
      if (action.revisionId !== args.revisionId || action.attemptId !== args.attemptId || action.attemptStatus !== 'running' || action.attemptExecutorKind !== 'human') throw fault('STALE_ACTION');
      if (action.confirmationStage === null) throw fault('HUMAN_OUTPUT_REQUIRED');
      if (action.confirmationStage && ![action.confirmationStage === 'final' ? 'success' : 'approved', 'changes'].includes(args.decision)) throw fault('INVALID_ARGUMENT');
      const stage = args.decision === 'changes' ? 'review' : action.confirmationStage ?? args.stage;
      const result = { resources: [{ title: action.title, content: args.comment?.trim() || args.decision,
        metadata: { element_id: action.targetId, revision_id: args.revisionId, stage, outcome: args.decision, ...(args.source ? { source: args.source } : {}) } }] };
      try { return await runtime.elementsCall('elements_move_complete', { attempt_id: args.attemptId, result }, signal); }
      catch (error) {
        if (uncertain(error)) throw fault('OUTCOME_UNKNOWN');
        throw error;
      }
    },
    /** Только текст реального входящего сообщения из доверенного Telegram плагина. */
    async feedback(args, signal) {
      if (!exact(args, ['elementId', 'revisionId', 'moveId', 'decision', 'feedback']) || !uuid(args.elementId) || !uuid(args.revisionId) ||
          !['changes', 'cancelled'].includes(args.decision) || !uuid(args.feedback?.id) || typeof args.feedback?.content !== 'string' ||
          !args.feedback.content.trim() || args.feedback.content.length > 16_000 || !args.feedback.source || typeof args.feedback.source !== 'object') throw fault('INVALID_ARGUMENT');
      const graph = await runtime.graph(signal), target = graph.elements.find(element => element.id === args.elementId);
      if (!target) throw fault('NOT_FOUND');
      if (args.decision === 'cancelled') {
        try { return await runtime.elementsCall('elements_element_activate', { element_id: target.id, revision_id: args.revisionId, cancel: true, feedback: args.feedback }, signal); }
        catch (error) { if (uncertain(error)) throw fault('OUTCOME_UNKNOWN'); throw error; }
      }
      if (target.revision !== args.revisionId || ['completed', 'cancelled'].includes(target.status)) throw fault('STALE_ACTION');
      const { action } = await lookup({ moveId: args.moveId }, signal);
      if (action.targetId !== target.id || !['planning', 'final'].includes(action.confirmationStage)) throw fault('HUMAN_OUTPUT_REQUIRED');
      return this.complete({ moveId: action.moveId, revisionId: args.revisionId, attemptId: action.attemptId,
        stage: 'review', decision: 'changes', comment: args.feedback.content, source: args.feedback.source }, signal);
    },
    /** Освобождает истёкшую или отменённую human attempt, сохраняя технический итог и planned Move. */
    async cancel(args, signal) {
      if (!exact(args, ['moveId', 'attemptId', 'revisionId', 'reason']) || !uuid(args.attemptId) || !uuid(args.revisionId) ||
        !['expired', 'cancelled', 'declined'].includes(args.reason)) throw fault('INVALID_ARGUMENT');
      const { action } = await lookup(args, signal);
      if (action.attemptId !== args.attemptId || action.attemptStatus !== 'running' || action.attemptExecutorKind !== 'human') throw fault('STALE_ACTION');
      try { return await runtime.elementsCall('elements_move_fail', { attempt_id: args.attemptId, error_code: `HUMAN_${args.reason.toUpperCase()}` }, signal); }
      catch (error) {
        if (uncertain(error)) throw fault('OUTCOME_UNKNOWN');
        throw error;
      }
    },
  };
}
