// ABOUTME: Преобразует структурированные асинхронные вопросы Codex в карточки.
// ABOUTME: Ответ остаётся native сообщением; текстовые списки вопросами не считаются.
import { bytes, limits } from '../contracts/index.mjs';
import type { PendingRequest } from '../contracts/index.mjs';

export const asyncQuestionMethod = 'agentMessage/questions';

/** Сохраняет исходные title/options и Desktop ID; слишком большую форму не сокращает. */
export function asyncQuestionRequest(item: any, turnId: string): PendingRequest | null {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions) || !item.questions.length) return null;
  const questions = item.questions.map((question: any, index: number) => ({
    id: JSON.stringify(['request_user_input_async', item.id, index]), question: question.title, isOther: true,
    options: (question.options ?? []).map((label: string) => ({ label, description: '' })),
  }));
  const request: PendingRequest = { requestId: 'async:' + item.id, turnId, method: asyncQuestionMethod, kind: 'question', params: { itemId: item.id, questions }, answered: false };
  return request.requestId.length <= 128 && bytes(request) <= limits.request ? request : null;
}

/** Принимает только полную Desktop обёртку ответа, а не похожий текст или пример JSON. */
export function asyncReplyIds(item: any): string[] {
  if (item.type !== 'userMessage') return [];
  const source = typeof item.text === 'string' ? item.text : (item.content ?? []).filter((part: any) => ['text', 'inputText'].includes(part.type)).map((part: any) => part.text).join('\n');
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(source);
  if (!match) return [];
  try {
    const rows = JSON.parse(match[1]);
    if (!Array.isArray(rows) || !rows.length || rows.some(row => typeof row?.questionItemId !== 'string' || typeof row.question !== 'string' || typeof row.answer !== 'string')) return [];
    return rows.map(row => row.questionItemId);
  } catch { return []; }
}

/** Проверяет полный набор ID и строит исходную обёртку; пустой answers означает пропуск. */
export function asyncQuestionReply(request: PendingRequest, answer: any): string | null {
  const questions = request.params.questions;
  if (!answer || Object.keys(answer).join() !== 'answers' || !answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers)
    || Object.keys(answer.answers).sort().join() !== questions.map((question: any) => question.id).sort().join()) return null;
  const rows = [];
  for (const question of questions) {
    const value = answer.answers[question.id];
    if (!value || Object.keys(value).join() !== 'answers' || !Array.isArray(value.answers) || value.answers.length > 1
      || value.answers.some((text: any) => typeof text !== 'string' || !text.trim())) return null;
    rows.push({ questionItemId: question.id, question: question.question, answer: value.answers[0] ?? '' });
  }
  const result = '<send_user_message_question_reply>\n' + JSON.stringify(rows) + '\n</send_user_message_question_reply>';
  return result.length <= 65536 ? result : null;
}
